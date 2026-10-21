// docs/adr/0011: help written so that an AI agent can use chat-log from it alone.

const COMMON = `共通のオプション:
  --provider <名前>     提供元で絞る（claude-code、claude-cowork、claude-ai）
  --cwd <ディレクトリ>   セッションの cwd が、そのディレクトリか、その下のものに絞る（相対パスは絶対パスにする）
                        既定で絞るのは context だけ。sessions、search、show は絞らないので、
                        いまのプロジェクトに絞るには --cwd . を付ける
  --since <時刻>        その時刻より後のもの（search はメッセージの時刻、sessions と context はセッションの最後の時刻で比べる）
  --until <時刻>        その時刻より前のもの（search はメッセージの時刻、sessions と context はセッションの最初の時刻で比べる。
                        --since と合わせると、その期間に重なるセッションになる）。show には効かない
                        <時刻> は 2026-10-01、2026-10-01T12:00:00+09:00、7d、12h、30m（7d は7日前）。
                        日付だけは UTC の 0 時、オフセットの無い時刻は手元の時刻帯として読む
  --limit <数>          件数
  --offset <数>         読み飛ばす件数
  --max-chars <数>      1つのメッセージの本文をこの文字数で切る（0 で切らない）。切ったときは末尾に「…（N 文字のうち M 文字）」
  --json                1行に1つの JSON（JSON Lines）で出す
  -h, --help            ヘルプ`;

const CONTEXT = `chat-log context [オプション]
  文脈を戻すための最初の一手。プロジェクトの最近のセッションと、それぞれの最後のやりとり（テキストだけ）を出す。
  既定では実行したディレクトリ（とその下）の cwd のセッションに絞る。
  --all                 cwd で絞らない
  --messages <数>       各セッションの最後のメッセージの数（既定 4）
  既定: --limit 5、--max-chars 500
  出力:
    # <cwd か「すべて」> の最近のセッション（<件数>）

    ## <タイトル>（<提供元>、<セッションIDの先頭8文字>、<最初の時刻>〜<最後の時刻>、<メッセージ数> 件）
    #<番号> <役割>: <本文>
  --json: セッションごとに1行。sessions のキーに last_messages（show の形の配列）を足したもの`;

const SESSIONS = `chat-log sessions [オプション]
  セッションの一覧。新しい順。既定: --limit 50
  出力（1行1セッション、タブ区切り）:
    <最後の時刻>	<提供元>	<セッションIDの先頭8文字>	<メッセージ数>	<タイトル>	<cwd>
  --json: provider、session_id、title、cwd、first_at、last_at、message_count`;

const SEARCH = `chat-log search <語...> [オプション]
  本文の全文検索。語はすべて含むもの（AND）。新しい順。写し（下の「用語」）は1回だけ出る。既定: --limit 20
  3文字以上の語は索引で引く。3文字未満の語（日本語の2文字の語など）は全件を走査するので遅い。
  本文の対象は、メッセージのテキストと思考。ツールの入出力は対象外。
  既定ではプロジェクトに絞らない。いまのプロジェクトだけを探すには --cwd . を付ける。
  出力（1件2行。一致した部分は ⟪ ⟫ で囲む。本文の ** は Markdown の太字で、強調ではない）:
  抜粋は、語ごとに最初に一致した位置の前後32文字。離れた範囲のあいだと、本文を切ったところに … を置く。
    <時刻>	<提供元>	<セッションIDの先頭8文字>#<メッセージの番号>	<役割>	<タイトル>
    	<抜粋>
  思考（thinking）にだけ一致したときは、抜粋の先頭に [thinking] が付く。
  <セッションIDの先頭8文字> と <メッセージの番号> は、そのまま show と show --around に渡せる。
  show --around はその番号のメッセージの思考も出すので、[thinking] の付いた結果もそのまま読める。
  --json: provider、session_id、index、uuid、timestamp、role、title、snippet、matched_in（["text"]、["thinking"]、["text","thinking"]）`;

const SHOW = `chat-log show <セッションID> [オプション]
  1つのセッションのメッセージを順に出す。セッションIDは、ほかと区別できれば先頭8文字以上でよい。
  メッセージの番号は、そのセッションの中の通し番号（1始まり、時刻の順）。
  --around <番号>       その番号を含む --limit 件を出す。番号の前に --limit の半分（切り捨て）件を置く。
                        --limit 1 ならその番号の1件だけ。search の #<番号> をそのまま渡せる。
                        その番号のメッセージは、--thinking が無くても思考を出す
  --thinking            思考（thinking）を出す（既定では出さない）
  --tools               ツールの入出力を全文で出す（既定では1行・200文字に要約する）
  既定ではプロジェクトに絞らない（セッションIDで決まるため --cwd は要らない）。
  既定: --limit 50、--max-chars 2000。--around を付けて --limit が無いときは 10（番号の前に 5 件）
  出力:
    ## #<番号> <役割> <時刻>
    <本文>
    [tool_use <名前>] <入力の JSON の先頭200文字>
    [tool_result] <出力の先頭200文字>
    [<その他のブロックの種類>]
  画像などのテキストでないブロックは [<種類>]、200文字以上の base64 は [base64 <文字数> 文字] になる（--tools でも）。
  表示するものが無いメッセージ（思考だけのものなど）は出さない。番号は詰めないので、番号の飛びは省いたメッセージ。
  --limit は番号の範囲で数える（省いたメッセージも数える）。
  続きがあるときは最後に「（続き：#<次の番号> から。--offset <数> で出す）」の行。--around のときも、その --offset で続きを出せる。
  --around で1件目より後から始まったときは、先頭に「（前：#1〜#<数> は --offset 0 で出す）」の行。
  --json: index、uuid、timestamp、role、model、is_sidechain、blocks（kind と text、name、input、type、truncated_from）`;

export const HELP: Record<string, string> = { context: CONTEXT, sessions: SESSIONS, search: SEARCH, show: SHOW };

export const MAIN_HELP = `chat-log: Claude の会話の履歴（Claude Code、Cowork、claude.ai）を引く、読み取り専用の CLI。
AI のエージェントが、過去の経緯や決定を思い出して文脈を戻すために使う。

使う順序の勧め: context → search → show --around
  1. chat-log context                     いまのプロジェクトの最近のセッションを知る
  2. chat-log search <語> --cwd .         決定や議論を探す（結果に <ID>#<番号> が出る。--cwd . でいまのプロジェクトに絞る）
  3. chat-log show <ID> --around <番号>   その前後の会話を読む

サブコマンド:

${CONTEXT}

${SESSIONS}

${SEARCH}

${SHOW}

${COMMON}

用語:
  写し: fork したセッションなどで、同じ提供元・セッションID・uuid のレコードが複数のファイルにあるもの。
        パス、generation、行番号の順で最初の1つだけを使い、ほかは会話・検索・件数から除く。
  メッセージの番号: セッションの中の通し番号（1始まり、時刻の順。写しは数えない）。

終了コード:
  0  成功（結果が0件のときも含む）
  1  指定したセッションが無い、セッションIDが区別できない（候補を標準エラー出力に書く）
  2  使い方の誤り、データベースが無い・古い、設定の書式の誤り

注意:
  - データベースは毎時の取り込みで更新される。最新の1時間ぶんが無いことがある。最新にしたいときは、先に bin/sync（インストールしたものは ai-chat-logs-sync）を実行する。
  - 履歴には秘密の情報が含まれうる。出力を外へ送らない。
  - データベースの場所は AI_CHAT_LOGS_DB（環境変数、リポジトリの .env、~/.config/ai-chat-logs/config.env の順）、無ければ ~/.local/share/ai-chat-logs/logs.sqlite。

例:
  chat-log context
  chat-log search ADR 写し --cwd .
  chat-log show 5a1e0a3b --around 120
  chat-log search pm2 --since 2026-10-01 --until 2026-10-08
  chat-log sessions --provider claude-ai --since 30d --json
`;
