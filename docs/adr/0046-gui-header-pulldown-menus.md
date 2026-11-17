# ADR 0046: GUI の会話の欄の見出しのボタンをプルダウンにまとめる

Status: accepted-pending

## 文脈

この ADR では、次の語を使う。

- **会話の欄の見出し**：GUI の会話の欄の上端の、スクロールしても残る部分（[ADR 0024](0024-gui-conversation-header-and-block-filter.md)）。`gui/src/main.ts` の `statusBox` である。3段からなり、1段目は提供元の表示、ページの状態、ボタン類、2段目は文脈の行（`contextBar`）、3段目は書き出しの結果の欄（`exportStatus`）である。
- **プルダウン**：押すと下に項目の欄（パネル）を開き、閉じる操作（下の「2. プルダウンの部品」）で閉じる部品。
- **「操作」のプルダウン**、**「表示」のプルダウン**：この ADR が置く2つのプルダウン。

会話の欄の見出しの1段目には、ボタン3つとチェックボックス4つが横に並んでいる。
[ADR 0024](0024-gui-conversation-header-and-block-filter.md) が「表示」のメニューを置き、[ADR 0026](0026-export-sessions-and-highlight-terms.md) が「書き出す」ボタンを足し、[ADR 0040](0040-session-and-message-ids-in-chat-log-and-gui.md) が2つのコピーのボタンを足した。
[ADR 0037](0037-codex-session-presentation.md) は、「表示」のメニューに4つ目のチェックボックス（表示できない内容）を足した。
1段目が長くなったので、利用者はボタン類をプルダウンにまとめることを求めた。

この ADR は、見出しの1段目のボタンを「操作」のプルダウンに、チェックボックスを「表示」のプルダウンにまとめることを決める。

## 調査した事項

`gui/src/main.ts` と `gui/src/visibility.ts`（main の c88c9cd。その後 da9a599 まで `gui/` は変わっていない）を読んで、次を確かめた。

| 確かめたこと | 箇所 | 中身 |
| --- | --- | --- |
| 見出しの組み立て | `main.ts:382-390` の `statusBox` | class は `sticky top-0 z-10 -mt-4 bg-white/90 py-1`。1段目に、提供元の表示（`conversation-provider`）、ページの状態（`statusText`）、右端の箱。2段目に文脈の行、3段目に書き出しの結果の欄 |
| 右端の箱 | `main.ts:386` | 「セッションIDをコピー」「セッションをコピー」「書き出す」の3つのボタンと、「表示」のメニュー（`shownMenu`）を横に並べる |
| 「表示」のメニュー | `main.ts:261-293` | 「表示」の文字の後に、thinking、tool_use、tool_result、表示できない内容の4つのチェックボックスを横に並べる。選んだものは `localStorage` に残す |
| チェックボックスの既定 | `visibility.ts:7` の `ALL_SHOWN` | thinking、tool_use、tool_result は入っていて、表示できない内容（`unavailable`）は外れている |
| 保存した値の読み書き | `visibility.ts:19-35` の `serializeShown` と `parseShown` | 読めない値は `ALL_SHOWN` を返す |
| 書き出すボタン | `main.ts:321-343` | 名前は「書き出す」。保存先を選ぶダイアログを開き、結果を `exportStatus` に出す。class に `disabled:opacity-50` がある |
| コピーのボタン | `main.ts:348-366` の `copyButton` | 押すと、クリックの伝播を止め（`event.stopPropagation()`）、2秒間「コピーしました」と出す。失敗は `exportStatus` に出す |
| 見出しのコピーのボタン | `main.ts:375-380` | 最初は押せない（`disabled = true`）。`main.ts:504-506` でセッションを開いたときに押せるようにする |
| `exportStatus` | `main.ts:320` | 見出しの全幅で、改行して出す（`whitespace-pre-wrap break-all`）。空なら隠す |

GUI には、DOM を使うテストの仕組みが無い。
`gui/tests/` のテストは、`gui/src/` の純粋な関数だけを確かめている（`visibility.test.ts`、`session-meta.test.ts` など）。
`gui/package.json` の `dependencies` は `@tauri-apps/api` と `@tauri-apps/plugin-dialog`、`devDependencies` は Tauri の CLI と Tailwind で、メニューの部品の依存は無い。
`gui/src/main.ts` には、`Escape` と `keydown` を扱う処理が無い。

## 実装すること

### 1. 見出しの1段目

見出しの1段目は、左から、提供元の表示、ページの状態、「操作」のプルダウン、「表示」のプルダウンの順に並べる。
2段目の文脈の行と、3段目の書き出しの結果の欄は変えない。

### 2. プルダウンの部品

プルダウンは、HTML の `<details>` と `<summary>` で作る。
新しい依存は足さない。

- `<summary>` の中身は、名前、半角の空白、「▾」の順に並べる。`<summary>` は、いまのボタンと同じ枠と文字の大きさにする。
- パネルは、`<summary>` の下に、右端をそろえて、会話の中身を押し下げずに重ねて出す。パネルは不透明な白の背景と影を持ち、見出しとメッセージより前に出す。
- 次のときにパネルを閉じる。
  - もう一度 `<summary>` を押したとき（`<details>` の既定の振る舞い）。
  - パネルの外を押したとき。document の `pointerdown` を捕捉の段で聞き、押した先が開いているプルダウンの `<details>` の外なら閉じる。捕捉の段で聞くのは、クリックの伝播を止めるボタン（メッセージのコピーのボタン）を押したときも閉じるためである。
  - Escape キーを押したとき。document の `keydown` で聞き、開いているプルダウンを閉じて、その `<summary>` にフォーカスを移す。
  - もう一方のプルダウンを開いたとき。`<details>` の `toggle` を聞き、開いたら、もう一方を閉じる。`<details>` の `name` 属性には頼らない。
  - セッションを開いたとき（`openSession`）。両方を閉じる。
- 会話をスクロールしても閉じない。
- 2つのプルダウンが同時に開くことはない。

### 3. 「操作」のプルダウン

「操作」のプルダウンのパネルに、「セッションIDをコピー」「セッションをコピー」「書き出す…」の3つを、縦に並べる。
書き出しの項目の名前は、「書き出す」から「書き出す…」に変える。
押すとダイアログを開くことを示すためである。

- 各項目の振る舞い（2秒間の「コピーしました」、失敗を `exportStatus` に出すこと、セッションを開くまで押せないこと）は変えない。押せない項目は、いまと同じく半透明（`disabled:opacity-50`）にする。
- コピーが成功したときは、パネルを開いたままにする。「コピーしました」が見えるようにするためである。
- コピーが失敗したときは、パネルを閉じる。パネルの下に隠れる `exportStatus` の失敗の文が見えるようにするためである。
- 「書き出す…」を押したときは、パネルを閉じてから保存先を選ぶダイアログを開く。
- セッションを開いていないときも、「操作」のプルダウンは開ける。項目は押せない。

### 4. 「表示」のプルダウン

「表示」のプルダウンのパネルに、いまの4つのチェックボックスを、縦に並べる。

- チェックボックスの意味、既定、`localStorage` に残すことは変えない。
- チェックを変えても、パネルは閉じない。
- `<summary>` の名前は、`gui/src/visibility.ts` の純粋な関数 `shownMenuLabel(shown)` で作る。4つのチェックボックスがすべて既定（`ALL_SHOWN`）のままなら「表示」、既定と違うものがあれば「表示（N 個を変更）」とする。N は既定と違うチェックボックスの数である。「▾」は `shownMenuLabel` の返す値に含めない。
- チェックを変えたときと、GUI を起動したときに、`<summary>` の名前を作りなおす。

### 5. 文書

`docs/specifications.md` の GUI の節で、次の4項目を直し、この ADR へのリンクを付ける。

- 会話の欄の上端（184行）：1段目の並びを、この ADR の1のとおりにする。
- 書き出し（185行）：「書き出す」ボタンを、「操作」のプルダウンの「書き出す…」にする。
- コピー（188行）：見出しのコピーのボタンを、「操作」のプルダウンの項目にする。
- 「表示」のメニュー（190行）：「表示」のプルダウンにし、表示できない内容のチェックボックス（既定は外れている。[ADR 0037](0037-codex-session-presentation.md)）も書く。いまの仕様書はこれを書いていない。

`README.md` の GUI の説明で、書き出す（354行）、コピー（355行）、「表示」のメニュー（356行）の場所を、2つのプルダウンに直す。

### 6. 前の ADR のステータス

この ADR を採択するときに、次のとおりステータスを変える。

- [ADR 0024](0024-gui-conversation-header-and-block-filter.md)：`superseded [{"part":"2. ブロックの種類を隠すメニュー: 置き場所と並べ方","by":["docs/adr/0046-gui-header-pulldown-menus.md"]}]`
- [ADR 0026](0026-export-sessions-and-highlight-terms.md)：`superseded [{"part":"2. GUI の「書き出す」ボタン: 置き場所と名前","by":["docs/adr/0046-gui-header-pulldown-menus.md"]}]`
- [ADR 0040](0040-session-and-message-ids-in-chat-log-and-gui.md)：いまの変更の配列に、`{"part":"5. GUI：IDとセッションとメッセージのコピー: 見出しのボタンの置き場所","by":["docs/adr/0046-gui-header-pulldown-menus.md"]}` と `{"part":"6. GUI：会話の欄の上にメタデータを出す: 見出しの1段目の並び","by":["docs/adr/0046-gui-header-pulldown-menus.md"]}` を足す。

## 実装しないこと

- 各メッセージの見出しの「IDをコピー」と「コピー」のボタン。利用者が求めたのは会話の欄の見出しで、メッセージごとのボタンは押す対象のメッセージの隣にあるほうが使いやすい。
- パネルの中の矢印キーでの項目の移動。`<details>` と、ボタンとチェックボックスの既定のキーボードの操作だけにする。
- メニューの部品の依存を足すこと。

## 不変条件

- I1：`shownMenuLabel(shown)` は、`shown` の4つの値（thinking、tool_use、tool_result、`unavailable`。`unavailable` が無いときは偽とみなす）がすべて `ALL_SHOWN` と同じとき「表示」を返し、違うものが N 個（1 ≤ N ≤ 4）のとき「表示（N 個を変更）」を返す。
- I2：どの `shown` でも、`shownMenuLabel(parseShown(serializeShown(shown)))` は `shownMenuLabel(shown)` と等しい。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| `ALL_SHOWN` | 「表示」 | I1 |
| `unavailable` が無い `{ thinking: true, tool_use: true, tool_result: true }` | 「表示」 | I1 |
| tool_use だけを外した | 「表示（1 個を変更）」 | I1, I2 |
| 表示できない内容だけを入れた | 「表示（1 個を変更）」 | I1, I2 |
| 4つとも既定と逆 | 「表示（4 個を変更）」 | I1, I2 |
| `parseShown(null)`、`parseShown("{")` | 「表示」 | I1 |
| `parseShown('{"tool_use":false}')` | 「表示（1 個を変更）」 | I1 |

プルダウンの開け閉めは DOM の振る舞いなので、不変条件にはせず、受けいれ条件で手で確かめる。

## 受けいれ条件

GUI を作りなおし、次を手で確かめる。

- A1：会話を開くと、見出しの1段目に、提供元、ページの状態、「操作 ▾」、「表示 ▾」だけが並び、ボタンとチェックボックスは並ばない。
- A2：「操作 ▾」を押すとパネルが開き、3つの項目が縦に並ぶ。パネルは会話を押し下げない。「セッションIDをコピー」を押すと、パネルが開いたまま2秒間「コピーしました」と出て、クリップボードにセッションIDが入る。
- A3：「書き出す…」を押すと、パネルが閉じて保存先のダイアログが開く。
- A4：「表示 ▾」を押してから tool_use のチェックを外すと、パネルが開いたまま tool_use のブロックが消え、`<summary>` が「表示（1 個を変更） ▾」になる。GUI を起動しなおしても、「表示（1 個を変更） ▾」のままである。
- A5：開いたパネルは、次のどれでも閉じる。もう一度 `<summary>` を押す。パネルの外を押す。メッセージの「IDをコピー」を押す。Escape キーを押す（フォーカスは `<summary>` に戻る）。もう一方のプルダウンを開く。サイドバーで別のセッションを開く。
- A6：セッションを開く前も「操作 ▾」は開け、項目は半透明で押せない。
- A7：Tab キーで `<summary>` にフォーカスを移し、Enter キーでパネルを開け閉めできる。

## テスト設計

`gui/tests/visibility.test.ts` に、次のテストを足す。
テストの名前は `ADR 0046 I<番号>: ...` とする。

1. `ADR 0046 I1`：境界の表の、I1 の行。
2. `ADR 0046 I2`：境界の表の、I2 の行の値を `serializeShown` してから `parseShown` で戻したもの。

A1〜A7 は、GUI を作りなおして手で確かめ、画面の写しで確かめた結果を実装の PR に書く。

## トレードオフ

- ボタンを押すのに、プルダウンを開く1回が増える。代わりに、見出しの1段目が短くなり、ページの状態が狭いウィンドウでも切れにくくなる。
- `<details>` は、外を押しても、Escape キーを押しても閉じないので、document の `pointerdown` と `keydown` を聞いて閉じる処理を書く。依存を足すより小さい。
- `<details>` の `name` 属性を使えば、同時に開かないことを自分で書かずに済む。しかし、Tauri が使う macOS の WebView が対応しているかを確かめていない（未確認）ので、`toggle` を聞いて自分で閉じる。

## 参考文献

- [ADR 0024](0024-gui-conversation-header-and-block-filter.md)：会話の欄の見出しと「表示」のメニュー。
- [ADR 0026](0026-export-sessions-and-highlight-terms.md)：書き出すボタン。
- [ADR 0037](0037-codex-session-presentation.md)：「表示できない内容」のチェックボックス。
- [ADR 0040](0040-session-and-message-ids-in-chat-log-and-gui.md)：コピーのボタン。
- MDN「`<details>`: The Details disclosure element」：https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details
