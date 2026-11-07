# ADR 0030: GUI のアプリのアイコン

ステータス: 採択

## 文脈

GUI（[ADR 0003](0003-tauri-log-viewer-with-search.md)）のアイコンは、`gui/src-tauri/icons/` にある Tauri の雛形のもの（`icon.png` は 512×512）のままである。
Dock や Finder で、ほかの Tauri のアプリと見分けがつかない。

利用者に、SVG で描いたアイコンの候補を10個見せ、07（時間軸）が選ばれた（2026-11-08）。
07 は、暗い紺の角丸の正方形に、縦の時間軸と、その上の3つの点と、点から右へ伸びる3本の記録の帯（青、黄、緑）を描いたものである。
会話の記録が時刻の順に積み重なることを表す。

Tauri の CLI の `tauri icon` は、正方形の PNG か SVG から、各プラットフォームの大きさのアイコン（`.icns`、`.ico`、PNG）を作る。

## 実装すること

- 07 の SVG を `gui/app-icon.svg` としてリポジトリに置く。アイコンの元はこのファイルとする。
  - 1024×1024 の `viewBox` で、角丸の正方形（896×896、角の半径 200）の外側は透明にする。macOS のアイコンの格子に合わせ、周りに 64 の余白を残す。
- `bun run tauri icon app-icon.svg`（`gui/` で実行）で `gui/src-tauri/icons/` のアイコンを作りなおし、コミットする。
  - `tauri.conf.json` の `bundle.icon` が指すファイル（`32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico`）を置きかえる。
  - `tauri icon` が作る、ほかのプラットフォーム（iOS、Android、Windows のストア）向けのファイルはコミットしない。
- `docs/specifications.md` の GUI の節と、README の開発の手順に、アイコンの元と作りなおし方を書く。

## 実装しないこと

- ウィンドウの中（画面の見出しなど）にアイコンを出すこと。
- ダークモード用や、メニューバー用のアイコン。
- `pm2` や `chat-log` など、GUI 以外のアイコン。

## テスト設計

アイコンは画像なので、自動のテストは書かない。次を手で確かめる。

1. `tauri icon` の後、`icon.icns` に 16〜1024 の大きさが入っている（`iconutil -c iconset` で展開して確かめる）。
2. `bun run tauri build --bundles app` で作った `AI Chat Logs.app` が、Finder と Dock で 07 のアイコンで出る。
3. 32×32 の PNG で、時間軸と3本の帯が見分けられる。

## トレードオフ

- 図柄が抽象的で、チャットのアプリだとは一目では分からない。時間の順の記録であることを優先した。
- 生成したアイコンをコミットするので、元の SVG を変えたら `tauri icon` をやりなおす必要がある。ビルドのたびに作ると、`tauri build` の前に手順が1つ増えるため、コミットする方を選ぶ。

## 参考文献

- Tauri の `icon` コマンド：https://v2.tauri.app/reference/cli/#icon
- Apple Human Interface Guidelines（App icons）：https://developer.apple.com/design/human-interface-guidelines/app-icons
