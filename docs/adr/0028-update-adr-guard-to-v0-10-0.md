# ADR 0028: adr-guard を v0.10.0 に上げる

ステータス: 採択

## 文脈

このリポジトリは、コミット済みの ADR の変更を [adr-guard](https://github.com/tett23/adr-guard) で拒否している。
[ADR 0012](0012-update-adr-guard-to-v0-8-3.md) で、CI（`.github/workflows/ci.yml` の `adr` ジョブ）の adr-guard を v0.8.3 に上げた。pre-commit の hook（`.githooks/pre-commit`）は `adr-guard pre-commit --allow-status --allow-links` を実行する。

adr-guard v0.9.0 から v0.10.0 で、次が加わった。

- v0.9.0：サブコマンド `adr-guard check-numbers`。同じディレクトリで番号が重複した ADR を報告する。CI の action は既定でこれを実行する（入力 `check-numbers`）。重複は `adr-guard renumber [--dry-run]` で直せる。番号の付けかえを許す `--allow-renumber`（action の入力 `allow-renumber`、既定は false）。
- v0.9.1：`renumber` の誤報の修正。
- v0.10.0：修飾子付きの ADR の参照。`ADR NNNN` の直前の語（空白1つで隔てたもの）を修飾子とみなす。`/` を含む語はディレクトリ、`-` を含む語はモジュール（`docs/<モジュール>/adr/`）、それ以外の語はそのモジュールがあるときだけ修飾子になる。`links` と pre-commit は、ディレクトリや ADR が存在しない修飾子付きの参照、リンク先が修飾子の ADR と異なるリンク、リンクの外に出た修飾子を報告する。シンボリックリンクの `.md` は検査しない。

手元の adr-guard は 0.10.0 で、pre-commit の hook は既にこの版で動いている。CI だけが v0.8.3 のままで、手元と CI で版が食い違う。

v0.10.0 の `adr-guard links` は、いまの main で失敗する。[ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) の本文が、adr-guard のリポジトリの ADR（[tett23/adr-guard ADR 0015](https://github.com/tett23/adr-guard/blob/main/docs/adr/0015-allow-link-changes.md)）を、リンクの無い「tett23/adr-guard」を前に置いた形で3か所書いている。v0.10.0 はこの「tett23/adr-guard」を、`/` を含むのでディレクトリの修飾子とみなし、そのディレクトリが無いと報告する。`links --fix` では直らない。

## 実装すること

- `.github/workflows/ci.yml` の `adr` ジョブを `uses: tett23/adr-guard@v0.10.0` にする。ほかの入力（`base`、`head`、`allow-status`、`allow-links`）は変えない。`check-numbers` は既定（実行する）のままにする。
- `.githooks/pre-commit` のコマンドは変えない。
- `docs/specifications.md` の「ADR の保護」の版の記述を v0.10.0 にし、CI が ADR の番号の重複も検査すること（`adr-guard check-numbers`）と、修飾子付きの参照の規則を書く。
- README の「開発」から参照する ADR を、この ADR に合わせる。
- [ADR 0012](0012-update-adr-guard-to-v0-8-3.md) のステータスの行を、この ADR への参照を含む形に変える。
- `adr-guard links --fix --include-committed` を実行し、直らない参照（[ADR 0015](0015-distinguish-accepted-and-unimplemented-adrs.md) の3か所）は、adr-guard のリポジトリの ADR（[tett23/adr-guard ADR 0015「`--allow-links` で、ADRの参照以外のリンクを付ける・外す・リンク先を変える変更も許可する」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0015-allow-link-changes.md)）への外部リンクで囲む。見える文字は変えない。リンクだけの変更なので `--allow-links` で許可される。
- `adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` が終了コード0になるようにする。

## 実装しないこと

- `--allow-status`、`--allow-links` 以外の adr-guard の設定の追加（`--allow-renumber` は使わない）。
- 既存の ADR の内容の変更（ステータスの行と、リンクの付与を除く）。
- モジュールごとの ADR のディレクトリ（`docs/<モジュール>/adr/`）の導入。このリポジトリの ADR は `docs/adr/` だけにある。

## テスト設計

自動テストは書かない。このリポジトリには ADR の書式を検査するテストが無い。実装の後に次を確かめる。

1. `ruby -ryaml -e 'YAML.load_file(ARGV[0])' .github/workflows/ci.yml` が成功する。
2. `adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` が終了コード0で終わる。
3. 各コミットで pre-commit の hook が通り、`adr-guard check-range origin/main HEAD --allow-status --allow-links` が終了コード0で終わる。
4. PR の CI の `adr` ジョブが v0.10.0 で通る。

## トレードオフ

- 番号の重複を CI で検査すると、別のブランチで同じ番号の ADR を作ったときに、後からマージするほうの CI が失敗する。番号の付けかえの手間は増えるが、重複したまま main に入ることは防げる。
- 修飾子の規則により、ほかのリポジトリの ADR を「<所有者>/<リポジトリ> ADR NNNN」の形で書くと、リンクで囲まない限り検査で失敗する。ほかのリポジトリの ADR は、リンクのテキストごと外部リンクにする必要がある。
- 版を固定したタグ（`v0.10.0`）で参照するため、adr-guard の更新のたびにこのような ADR が要る（[ADR 0009](0009-update-adr-guard-to-v0-8-2.md)、[ADR 0012](0012-update-adr-guard-to-v0-8-3.md) と同じ）。

## 参考文献

- [tett23/adr-guard ADR 0018「重複したADRの番号の修復」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0018-repair-duplicate-adr-numbers.md)
- [tett23/adr-guard ADR 0019「モジュールで修飾したADRの参照」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0019-module-qualified-adr-references.md)
- [tett23/adr-guard ADR 0020「シンボリックリンクの文書を飛ばす」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0020-skip-symlinked-documents.md)
- adr-guard v0.9.0 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.9.0
- adr-guard v0.9.1 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.9.1
- adr-guard v0.10.0 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.10.0
