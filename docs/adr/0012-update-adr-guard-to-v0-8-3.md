# ADR 0012: adr-guard を v0.8.3 に上げる

ステータス: 採択

## 文脈

このリポジトリは、コミット済みの ADR の変更を [adr-guard](https://github.com/tett23/adr-guard) で拒否している。
[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) で、CI（`.github/workflows/ci.yml` の `adr` ジョブ）の adr-guard を v0.8.2 に上げた。pre-commit の hook（`.githooks/pre-commit`）は `adr-guard pre-commit --allow-status --allow-links` を実行する。

adr-guard v0.8.3 で、次が加わった。

- ステータス `採択（未実装）`（英語は `Accepted (not implemented)`。括弧は全角でも半角でもよい）。採択されたが、まだ実装されていない ADR を表す。
- サブコマンド `adr-guard unimplemented [--status]`。ステータスが `採択（未実装）` の ADR を一覧する。

手元の adr-guard は 0.8.3 で、pre-commit の hook は既にこの版で動いている。CI だけが v0.8.2 のままで、手元と CI で版が食い違う。

## 実装すること

- `.github/workflows/ci.yml` の `adr` ジョブを `uses: tett23/adr-guard@v0.8.3` にする。ほかの入力（`base`、`head`、`allow-status`、`allow-links`）は変えない。
- `.githooks/pre-commit` のコマンドは変えない。
- `docs/specifications.md` の「ADR の保護」の版の記述を v0.8.3 にし、ADR のステータスに `採択（未実装）` を使えることと、`adr-guard unimplemented` で一覧できることを書く。
- README の「開発」から参照する ADR を、この ADR に合わせる。
- `adr-guard links --fix --include-committed` を実行し、`adr-guard links` と `adr-guard check-status` が終了コード0になるようにする。

## 実装しないこと

- `--allow-status`、`--allow-links` 以外の adr-guard の設定の追加。
- 既存の ADR のステータスを `採択（未実装）` に書きかえること。
- 既存の ADR の内容の変更（ステータスの行と、`links --fix` によるリンクの付与を除く）。

## テスト設計

自動テストは書かない。このリポジトリには ADR の書式を検査するテストが無い。実装の後に次を確かめる。

1. `ruby -ryaml -e 'YAML.load_file(ARGV[0])' .github/workflows/ci.yml` が成功する。
2. `adr-guard links` と `adr-guard check-status` が終了コード0で終わる。
3. 各コミットで pre-commit の hook が通り、`adr-guard check-range origin/main HEAD --allow-status --allow-links` が終了コード0で終わる。
4. PR の CI の `adr` ジョブが v0.8.3 で通る。

## トレードオフ

- `採択（未実装）` を使うと、採択と実装の状態を ADR から区別できる。その代わり、実装が終わったときにステータスの行を `採択` に書きかえる手間が増える。ステータスの行の変更は `--allow-status` で許可している。
- 版を固定したタグ（`v0.8.3`）で参照するため、adr-guard の更新のたびにこのような ADR が要る（[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) と同じ）。

## 参考文献

- [tett23/adr-guard ADR 0016「ステータス `採択（未実装）` を加え、未実装のADRを一覧する `unimplemented` サブコマンド」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0016-accepted-not-implemented-status.md)
- adr-guard v0.8.3 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.8.3
