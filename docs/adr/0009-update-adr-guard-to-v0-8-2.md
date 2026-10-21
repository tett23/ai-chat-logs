# ADR 0009: adr-guard を v0.8.2 に上げる

ステータス: 採択→v0.8.3 への更新は[ADR 0012](0012-update-adr-guard-to-v0-8-3.md)

## 文脈

このリポジトリは、コミット済みの ADR の変更を [adr-guard](https://github.com/tett23/adr-guard) で拒否している。
`.githooks/pre-commit` で `adr-guard pre-commit --allow-status --allow-links` を実行し、CI（`.github/workflows/ci.yml` の `adr` ジョブ）で `tett23/adr-guard@v0.8.1` を `allow-status: true`、`allow-links: true` で使う。
adr-guard はリポジトリの初期化のときに導入しており、導入や版の更新を決めた ADR はこれまで無い。

adr-guard v0.8.2 で、`--allow-links` が許可する変更が広がった。
v0.8.1 までは ADR の参照のリンクの付与だけを許可していたが、v0.8.2 では、コミット済みの ADR の「リンクだけの変更」全般を許可する。

- 許可する：インラインリンク・参照形式リンクの追加・削除・リンク先の変更、画像のリンク先の変更、リンクの参照定義の行（`[1]: url`）の変更。
- 引き続き拒否する：リンクのテキストの変更、画像の追加・削除、自動リンク（`<url>`）や本文の URL の変更。
- 記録（`docs/audit/` など）は引き続き完全に保護する。

手元の adr-guard は 0.8.2 で、pre-commit の hook は既にこの版で動いている。CI だけが v0.8.1 のままで、手元と CI で判定が食い違う。

## 実装すること

- `.github/workflows/ci.yml` の `adr` ジョブを `uses: tett23/adr-guard@v0.8.2` にする。ほかの入力（`base`、`head`、`allow-status`、`allow-links`）は変えない。
- `.githooks/pre-commit` のコマンドは変えない。
- README の「開発」と `docs/specifications.md` に、adr-guard が許可する変更（ステータスの行と、リンクだけの変更）を書く。
- `adr-guard links --fix --include-committed` を実行し、`adr-guard links` と `adr-guard check-status` が終了コード0になるようにする。

## 実装しないこと

- `--allow-status`、`--allow-links` 以外の adr-guard の設定の追加。
- 既存の ADR の内容の変更（ステータスの行と、`links --fix` によるリンクの付与を除く）。

## テスト設計

自動テストは書かない。実装の後に次を確かめる。

1. `ruby -ryaml -e 'YAML.load_file(ARGV[0])' .github/workflows/ci.yml` が成功する。
2. `adr-guard links` と `adr-guard check-status` が終了コード0で終わる。
3. 各コミットで pre-commit の hook が通り、`adr-guard check-range origin/main HEAD --allow-status --allow-links` が終了コード0で終わる。
4. PR の CI の `adr` ジョブが v0.8.2 で通る。

## トレードオフ

- 許可する変更が広がるため、コミット済みの ADR のリンク先を書きかえて、参照先の意味を変えることができる。リンクのテキストと本文は保護されるので、読み手に見える記述は変わらない。リンク切れの修正をレビューの対象として受けいれる。
- 版を固定したタグ（`v0.8.2`）で参照するため、adr-guard の更新のたびにこのような ADR が要る。メジャー版のタグに追従させれば手間は減るが、判定が知らないうちに変わる。

## 参考文献

- [tett23/adr-guard ADR 0015「`--allow-links` で、ADRの参照以外のリンクを付ける・外す・リンク先を変える変更も許可する」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0015-allow-link-changes.md)：https://github.com/tett23/adr-guard/blob/main/docs/adr/0015-allow-link-changes.md
- adr-guard v0.8.2 のリリース：https://github.com/tett23/adr-guard/releases/tag/v0.8.2
