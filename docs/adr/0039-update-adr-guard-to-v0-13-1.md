# ADR 0039: adr-guard を v0.13.1 に上げ、ADR のステータスの行を新形式に移す

Status: accepted

## 文脈

このリポジトリは、コミット済みの ADR の変更を [adr-guard](https://github.com/tett23/adr-guard) で拒否している。
[ADR 0028](0028-update-adr-guard-to-v0-10-0.md) で、CI（`.github/workflows/ci.yml` の `adr` ジョブ）の adr-guard を v0.10.0 に上げた。
pre-commit の hook（`.githooks/pre-commit`）は `adr-guard pre-commit --allow-status --allow-links` を実行し、手元に入っている adr-guard の版で動く。

adr-guard は、その後 v0.11.0 から v0.13.1 までで次のように変わった。

- v0.11.0：Codex の PreToolUse hook として動くサブコマンド `adr-guard codex-hook`（[tett23/adr-guard ADR 0021](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0021-codex-hook.md)）。
- v0.12.0：ステータスの行の新形式と、状態遷移の検査（[tett23/adr-guard ADR 0022](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0022-status-transitions.md)）。
  - 新形式は `Status: <トークン>` である。トークンは `proposed`、`accepted`、`accepted-pending`、`rejected`、`discarded`、`deprecated` のいずれか、または `superseded [<変更の JSON 配列>]` である。変更は `{"part":<部分名か null>,"by":[<リポジトリのルートからのパス>]}` と書く。
  - 追加した ADR と、ステータスの行を書き換えた ADR には、新形式が要る。新しい ADR は、最初のコミットで `Status: proposed` でなければならない。
  - pre-commit と `check-range` は、HEAD からの状態遷移を検査する（例：`proposed` から `accepted-pending`、`accepted` から `superseded`）。遷移の違反は `--allow-status`、環境変数 `ADR_GUARD_ALLOW`、コミットのトレーラーでも免除されない。
  - 旧形式（`ステータス: 採択` など）の行は、書き換えない限りそのまま読める。旧形式から新形式への書き換えは、同じ状態への移行として許される。
  - 旧形式を新形式に書き換える移行スクリプト `scripts/migrate-adr-status` が adr-guard のソースにある。リリースのアーカイブには入らない。
  - 修正先を辿るサブコマンド `adr-guard trace`（[tett23/adr-guard ADR 0023](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0023-trace-amendments.md)）。
- v0.13.0：
  - 移行スクリプトの `--dry-run` と、移行できない ADR の全件の数え上げ（[tett23/adr-guard ADR 0024](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0024-migration-dry-run-and-error-count.md)）。
  - 状態 `superseded-pending`（実装を待つ ADR が修正を受けた状態）、変更の `kind` と `note`、`https://` の修正先、`trace --list` の6列（[tett23/adr-guard ADR 0025](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0025-extend-canonical-status-amendments.md)）。
  - 旧形式の参照の読み方の拡張（[tett23/adr-guard ADR 0026](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0026-read-more-legacy-references.md)、[tett23/adr-guard ADR 0027](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0027-read-legacy-replaced-status.md)）。
- v0.13.1：移行スクリプトが旧形式の行から部分名を作るときに、修飾子（`ADR NNNN` の直前の語）、先頭の「。」、末尾の「→」を残さなくなった。部分名を規則で決められない行は、「部分名を決められません」と報告し、書き換えない（[tett23/adr-guard ADR 0028](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0028-fix-legacy-part-names.md)、[リリース](https://github.com/tett23/adr-guard/releases/tag/v0.13.1)）。

手元の adr-guard は 0.13.1 で、pre-commit の hook は既にこの版で動いている。
CI だけが v0.10.0 のままで、手元と CI で版が食い違う。

このリポジトリの ADR は、すべて旧形式のステータスの行を持つ。
また、ステータスの値と移り方は [ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) が決めている。
[ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) は、`提案` の ADR をコミットせず、採択した ADR を最初から `採択（未実装）` か `採択` でコミットする。
v0.13.1 の pre-commit は、最初のコミットが `proposed` でない ADR を拒否するので、この移り方には従えない。

## 調査した事項

次は、この ADR の worktree（origin/main から作ったブランチ `adr-guard-v0.13.0`）で実行して確かめた。

- `adr-guard -V` は `adr-guard 0.13.1` を出力した。
- `.github/workflows/ci.yml` の72行目は `- uses: tett23/adr-guard@v0.10.0` である。入力は `base`、`head`、`allow-status: true`、`allow-links: true` の4つである。
- `.githooks/pre-commit` は `exec adr-guard pre-commit --allow-status --allow-links` の1行である。
- adr-guard の v0.13.1 のタグはコミット `ab55769152ed0f8a3465ee3435a2df43ab9d067f` を指す。v0.13.1 の `action.yml` の入力は `base`、`head`、`version`、`allow-status`、`allow-links`、`links`、`check-status`、`check-numbers`、`allow-renumber` である。
- この ADR を足す前に、`adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` は、いずれも終了コード0で終わった。
- worktree のルートで、adr-guard の v0.13.1 のソースの `scripts/migrate-adr-status`（ビルドしたもの）を `--dry-run` で実行した。この ADR を足す前は、終了コード0で、標準エラーに `移行できる: 37件、移行済み: 0件、移行できない: 0件` を出力した。37件の内訳は `Status: accepted` が27件、`Status: superseded [...]` が10件である。
- v0.13.1 の移行スクリプトの `--dry-run` が出す新形式のステータスの行は、v0.13.0 の移行スクリプトの出力とすべて同じだった（`diff` で差が無かった）。
- 移行スクリプトは、[ADR 0012](0012-update-adr-guard-to-v0-8-3.md) の `採択→v0.10.0 への更新は[ADR 0028](0028-update-adr-guard-to-v0-10-0.md)` を `Status: superseded [{"by":["docs/adr/0028-update-adr-guard-to-v0-10-0.md"],"part":"v0.10.0 への更新"}]` に書き換える。[ADR 0028](0028-update-adr-guard-to-v0-10-0.md) と [ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) の `ステータス: 採択` は `Status: accepted` に書き換える。
- ステータスの値を書いた文書は、README.md の「開発」のステータスの表（`提案`、`採択（未実装）`、`採択`、`採択→<変わった部分>は ADR NNNN`）と、`docs/specifications.md` の「ADR の保護」の `採択（未実装）` の記述である。`CLAUDE.md` と `AGENTS.md` は無い。
- worktree を `$TMPDIR` に clone し、実装の手順を試した。この ADR を `Status: proposed` で足したインデックスで、`adr-guard pre-commit --allow-status --allow-links` は終了コード0で終わった。それをコミットし、ステータスを `Status: accepted-pending` にしたインデックスでも、終了コード0で終わった。
- 続けて、移行スクリプトの `--dry-run` は `移行できる: 37件、移行済み: 1件、移行できない: 0件`（移行済みの1件はこの ADR）を出力した。`--write` で書き換え、[ADR 0028](0028-update-adr-guard-to-v0-10-0.md) と [ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) のステータスの行を「前の ADR のステータス」の節の行にしたインデックスで、pre-commit は終了コード0で終わった。旧形式の `ステータス: 採択` から `Status: superseded [...]` への書き換えは、状態遷移の検査を通った。
- そのコミットの後、`--dry-run` は `移行できる: 0件、移行済み: 38件、移行できない: 0件` を出力した。`adr-guard check-status`、`adr-guard links`、`adr-guard check-numbers`、`adr-guard check-range origin/main HEAD --allow-status --allow-links` は、いずれも終了コード0で終わった。`^ステータス:` で始まる行は残らなかった。`adr-guard unimplemented` はこの ADR だけを出力した。
- 旧形式の ADR を足した main のコミット 9894e1a（[ADR 0038](0038-save-logs-before-compaction.md) を `ステータス: 採択` で足したもの）で `adr-guard check-range 9894e1a^ 9894e1a --allow-status --allow-links` を実行すると、「新形式のステータス行は `Status: ` で始めてください」 を出して終了コード1で終わった。同じ ADR のステータスを `採択（未実装）` から `採択` に書き換えたコミット 186c8e2 でも、同じ診断を出した。
- adr-guard のリポジトリでは、新しい ADR を `Propose ADR 0024: …` のコミットで `proposed` として入れ、続く `Accept ADR 0024 pending implementation` のコミットで `accepted-pending` にしている（`git log v0.10.0..v0.13.1`）。

## 実装すること

### CI

- `.github/workflows/ci.yml` の `adr` ジョブを `uses: tett23/adr-guard@v0.13.1` にする。いまと同じくタグで指定する。ほかの入力（`base`、`head`、`allow-status`、`allow-links`）は変えず、`check-numbers` は既定（実行する）のままにする。

### ステータスの行の移行

- worktree のルートで、adr-guard の v0.13.1 のソースの `scripts/migrate-adr-status` を `--dry-run` で実行し、移行できない ADR が0件であることを確かめてから、`--write` で書き換える。
- 移行は、すべての ADR のステータスの行だけを書き換える。本文は変えない。

### 前の ADR のステータス

- [ADR 0028](0028-update-adr-guard-to-v0-10-0.md) のステータスの行を `Status: superseded [{"part":"v0.13.1 への更新","by":["docs/adr/0039-update-adr-guard-to-v0-13-1.md"]}]` にする。部分名は、[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) と [ADR 0012](0012-update-adr-guard-to-v0-8-3.md) の「v0.8.3 への更新」「v0.10.0 への更新」に倣う。
- [ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) のステータスの行を `Status: superseded [{"part":"ステータスの値と移り方","by":["docs/adr/0039-update-adr-guard-to-v0-13-1.md"]}]` にする。

### ステータスの値と移り方

[ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) の「ステータスの値」と「移り方」を、次で置き換える。

| 値 | 意味 |
|---|---|
| `Status: proposed` | 提案した。レビューを受けたあと、この値で一度コミットする |
| `Status: accepted-pending` | 採択した。実装はまだ main に入っていない。`adr-guard unimplemented` で一覧できる |
| `Status: accepted` | 実装が main に入った（実装の要らない ADR は採択した時点で `accepted`） |
| `Status: superseded [...]` | 一部または全部が後の ADR で変わった。変わった部分と、変えた ADR のパスを JSON で書く |
| `Status: superseded-pending [...]` | 実装を待つ ADR の一部または全部が、後の ADR で変わった |
| `Status: rejected`、`Status: discarded` | 却下した、破棄した |

1. ADR を書き、`Status: proposed` のまま、コミットせずにレビューを受ける。
2. レビューで認められたら、`Status: proposed` のままコミットする。
3. 続くコミットで、実装の要る ADR は `accepted-pending`、実装の要らない ADR は `accepted` にする。
4. 実装の PR に、その ADR のステータスを `accepted-pending` から `accepted` にする変更を含める。実装を複数の PR に分けるときは、最後の PR で変える。

却下した ADR を記録として残すときは、`Status: proposed` でコミットし、続くコミットで `rejected` にする。

### 文書

- README.md の「開発」から参照する ADR にこの ADR を加え、ステータスの表と移り方を上の内容にする。
- `docs/specifications.md` の「ADR の保護」で、CI の版を v0.13.1 にし、ADR の一覧にこの ADR を加える。`採択（未実装）` の記述を `accepted-pending` に改め、ステータスの行の新形式と、pre-commit と CI が状態遷移を検査することを書く。
- `adr-guard links --fix` を実行し、`adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` が終了コード0で終わるようにする。

## 実装しないこと

- pre-commit の hook のコマンドの変更。`adr-guard pre-commit --allow-status --allow-links` のままにする。
- Claude Code の hook の変更。全体の設定（`~/.claude/settings.json`）にあるものを使う。
- Codex の hook（v0.11.0 の `adr-guard codex-hook`）の導入。
- 変更の `kind`（`supplement`、`note`）と `note`、`https://` の修正先の利用。移行の後の修正先は、このリポジトリの ADR のパスだけにする。
- 移行スクリプトをこのリポジトリに置くこと。移行は一度だけ行い、adr-guard の v0.13.1 のソースから実行する。
- CI の版を SHA で固定すること。いまと同じくタグで指定する。

## 不変条件

なし。
この ADR は、CI の版と ADR のステータスの行の書き方、その移り方の手順だけを決め、このリポジトリのプログラムの振る舞いを変えない。

## テスト設計

自動テストは書かない。
このリポジトリには ADR の書式を検査するテストが無い。
実装の後に次を確かめる。

1. `ruby -ryaml -e 'YAML.load_file(ARGV[0])' .github/workflows/ci.yml` が成功する。
2. 移行スクリプトの `--write` の後に `--dry-run` を実行すると、`移行できる: 0件` で、移行できない ADR が0件である。
3. `adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` が終了コード0で終わる。
4. `rg -n '^ステータス:' docs/adr` が何も出力しない。
5. 各コミットで pre-commit の hook が通り、`adr-guard check-range origin/main HEAD --allow-status --allow-links` が終了コード0で終わる。
6. `adr-guard trace --list docs/adr/0009-update-adr-guard-to-v0-8-2.md` が、[ADR 0028](0028-update-adr-guard-to-v0-10-0.md) からこの ADR への辺（部分名 `v0.13.1 への更新`）を出し、`adr-guard trace --list docs/adr/0015-distinguish-accepted-and-unimplemented-adrs.md` が、この ADR への辺（部分名 `ステータスの値と移り方`）を出す。
7. PR の CI の `adr` ジョブが v0.13.1 で通る。

## トレードオフ

- 手元と CI の版がそろい、新しい ADR を新形式で書ける。その代わり、ADR を足すたびに `proposed` のコミットと採択のコミットの2つが要る。
- 状態遷移の違反は `--allow-status` でも免除されないので、誤ったステータスの書き換え（`accepted` から `proposed` に戻すなど）を手元と CI で止められる。その代わり、誤って入れたステータスを戻すには、許された遷移を辿る必要がある。
- CI を上げた後は、旧形式のステータスの行で ADR を足すコミットと、旧形式の行を旧形式のまま書き換えるコミット（`採択（未実装）` から `採択` など）が、CI で失敗する。移行より前に分けたブランチにそのようなコミットがあれば、マージの前にステータスの行を新形式に直す。
- 37件の ADR のステータスの行を一度に書き換えるので、この PR の差分は大きい。書き換えはステータスの行だけで、`--allow-status` の範囲に収まる。
- 版を固定したタグ（`v0.13.1`）で参照するため、adr-guard の更新のたびにこのような ADR が要る（[ADR 0009](0009-update-adr-guard-to-v0-8-2.md)、[ADR 0012](0012-update-adr-guard-to-v0-8-3.md)、[ADR 0028](0028-update-adr-guard-to-v0-10-0.md) と同じ）。

## 参考文献

- [tett23/adr-guard ADR 0021「Codex の PreToolUse hook で、コミット済みのADRと記録の編集を拒否する」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0021-codex-hook.md)
- [tett23/adr-guard ADR 0022「状態と遷移を別々の代数的データ型で表す」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0022-status-transitions.md)
- [tett23/adr-guard ADR 0023「trace で元の決定から修正ADRをたどる」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0023-trace-amendments.md)
- [tett23/adr-guard ADR 0024「移行スクリプトに --dry-run を設け、失敗を最後まで数える」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0024-migration-dry-run-and-error-count.md)
- [tett23/adr-guard ADR 0025「新形式のステータス行に、実装待ちの修正、補足、注記、別のリポジトリの修正先を加える」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0025-extend-canonical-status-amendments.md)
- [tett23/adr-guard ADR 0026「旧形式のステータス行の修正先を、リンク先と裸の番号からも読む」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0026-read-more-legacy-references.md)
- [tett23/adr-guard ADR 0027「旧形式の `置換（…）` を、修正を受けた状態として読む」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0027-read-legacy-replaced-status.md)
- [tett23/adr-guard ADR 0028「旧形式の部分名から修飾子と区切りの記号を除き、決められない部分名を移行しない」](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0028-fix-legacy-part-names.md)
- adr-guard の README（v0.13.1）：https://github.com/tett23/adr-guard/blob/v0.13.1/README.md
- adr-guard v0.11.0 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.11.0
- adr-guard v0.12.0 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.12.0
- adr-guard v0.13.0 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.13.0
- adr-guard v0.13.1 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.13.1
