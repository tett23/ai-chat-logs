// docs/adr/0003: session list, search, and conversation view. docs/adr/0007: the settings and setup screen.
import { renderAdmin } from "./admin.ts";
import * as api from "./api.ts";
import { clear, h } from "./dom.ts";
import { splitFences } from "./fences.ts";
import { initialRange, newerRange, newestFirst, olderRange, type Range } from "./pages.ts";
import { type Filter, projectOptions, providerLabel } from "./projects.ts";
import { scanMessage } from "./scan.ts";
import { splitSnippet } from "./snippet.ts";

const PAGE = 50;
const SEARCH_DELAY_MS = 300;

type ListMode = { kind: "sessions" } | { kind: "search"; query: string };

const state = {
  filter: null as Filter | null,
  mode: { kind: "sessions" } as ListMode,
  offset: 0,
  done: false,
  loading: false,
  generation: 0, // bumps whenever the list is reset, so stale pages are dropped
  selected: null as string | null,
};

// Layout
const searchBox = h("input", {
  class: "w-full rounded border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400",
  attrs: { type: "search", placeholder: "検索（3文字以上の語は索引で引きます）" },
});
const notice = h("div", { class: "text-xs text-gray-500" });
const projectSelect = h("select", { class: "w-full rounded border border-gray-300 px-1 py-1" });
const list = h("ul", { class: "flex-1 overflow-y-auto divide-y divide-gray-100" });
const view = h("section", { class: "flex-1 overflow-y-auto p-4" });
// docs/adr/0010: kept on the browse screen, away from the setup buttons of the admin screen.
const scanButton = h(
  "button",
  { class: "whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-50" },
  ["ダウンロードしたエクスポートを取り込む"],
);
const scanStatus = h("div", { class: "text-xs text-gray-600" });
const scanDetails = h("details", { class: "hidden text-xs" }, [
  h("summary", { class: "cursor-pointer select-none text-gray-500" }, ["詳しく"]),
  h("pre", { class: "mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-1 font-mono" }),
]);

const browse = h("main", { class: "flex min-h-0 flex-1" }, [
  h("aside", { class: "flex w-96 flex-col border-r border-gray-200" }, [
    h("div", { class: "flex flex-col gap-1 border-b border-gray-200 p-2" }, [
      projectSelect,
      h("div", {}, [scanButton]),
      scanStatus,
      scanDetails,
    ]),
    list,
  ]),
  view,
]);
const admin = h("main", { class: "hidden min-h-0 flex-1 overflow-y-auto p-4" });

const tabClass = (active: boolean): string =>
  `shrink-0 whitespace-nowrap rounded px-3 py-1 text-sm ${active ? "bg-gray-900 text-white" : "border border-gray-300 hover:bg-gray-50"}`;
const browseTab = h("button", { class: tabClass(true) }, ["閲覧"]);
const adminTab = h("button", { class: tabClass(false) }, ["管理"]);

clear(
  document.getElementById("app") as HTMLElement,
  h("header", { class: "flex flex-col gap-1 border-b border-gray-200 p-2" }, [
    h("div", { class: "flex gap-2" }, [browseTab, adminTab, searchBox]),
    notice,
  ]),
  browse,
  admin,
);

const formatTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "");

const errorText = (error: api.StoreError): string => {
  switch (error.kind) {
    case "not_found":
      return `データベースが見つかりません: ${error.path}。chat-log-import を実行するか、AI_CHAT_LOGS_DB を付けて起動してください。`;
    case "old_schema":
      return `データベースのスキーマが古いです（${error.found}、必要なのは ${error.required}）。chat-log-import を実行してください。`;
    case "sqlite":
      return `データベースのエラー: ${error.message}`;
    case "settings":
      return `設定のエラー: ${error.message}`;
  }
};

const showError = (e: unknown): void => {
  const text = typeof e === "object" && e !== null && "kind" in e ? errorText(e as api.StoreError) : String(e);
  clear(view, h("p", { class: "text-red-700" }, [text]));
};

// Conversation view
const textParts = (text: string): Node[] =>
  splitFences(text).map((part) =>
    part.kind === "code"
      ? h("pre", { class: "my-1 overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs" }, [h("code", {}, [part.text])])
      : h("div", { class: "whitespace-pre-wrap break-words" }, [part.text]),
  );

// docs/adr/0005: the body of a folded part is built when it is first opened.
const folded = (summary: string, body: () => Node[], tone = "text-gray-500"): Node => {
  const content = h("div", { class: "mt-1 border-l-2 border-gray-200 pl-2" });
  const details = h("details", { class: "my-1" }, [
    h("summary", { class: `cursor-pointer select-none text-xs ${tone}` }, [summary]),
    content,
  ]);
  details.addEventListener("toggle", () => {
    if (details.open && content.childElementCount === 0) content.append(...body());
  });
  return details;
};

const preformatted = (text: string): Node =>
  h("pre", { class: "overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs" }, [text]);

const foldedBody = (block: Exclude<api.Block, { kind: "text" }>): Node[] => {
  switch (block.kind) {
    case "thinking":
      return textParts(block.text);
    case "tool_use":
      return [preformatted(block.input)];
    case "tool_result":
      return [preformatted(block.text)];
    case "other":
      return [preformatted(block.json)];
  }
};

const foldedSummary = (block: Exclude<api.Block, { kind: "text" }>): string => {
  switch (block.kind) {
    case "thinking":
      return "thinking";
    case "tool_use":
      return `tool_use: ${block.name}`;
    case "tool_result":
      return block.is_error ? "tool_result（エラー）" : "tool_result";
    case "other":
      return block.label;
  }
};

// A truncated block shows its head and a button that replaces it with the whole body.
const withLoadButton = (block: Exclude<api.Block, { kind: "text" }>, rowid: number, index: number): Node[] => {
  if (block.full_length === null) return foldedBody(block);
  const holder = h("div", {}, foldedBody(block));
  const button = h(
    "button",
    {
      class: "mt-1 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50",
      on: {
        click: () => {
          button.disabled = true;
          api
            .getBlock(rowid, index)
            .then((whole) => {
              if (whole.kind !== "text") clear(holder, ...foldedBody(whole));
              button.remove();
            })
            .catch(showError);
        },
      },
    },
    [`全文を読み込む（${block.full_length.toLocaleString()} 文字）`],
  );
  return [holder, button];
};

const blockNode = (block: api.Block, rowid: number, index: number): Node =>
  block.kind === "text"
    ? h("div", {}, textParts(block.text))
    : folded(
        foldedSummary(block),
        () => withLoadButton(block, rowid, index),
        block.kind === "tool_result" && block.is_error ? "text-red-600" : "text-gray-500",
      );

const messageNode = (message: api.Message): HTMLElement => {
  const isUser = message.role === "user";
  const header = h("div", { class: "mb-1 flex gap-2 text-xs text-gray-500" }, [
    h("span", { class: isUser ? "font-semibold text-blue-700" : "font-semibold text-emerald-700" }, [message.role ?? "?"]),
    message.model ? h("span", {}, [message.model]) : null,
    h("span", {}, [formatTime(message.timestamp)]),
  ]);
  const body = () => message.blocks.map((block, i) => blockNode(block, message.rowid, i));
  const content = message.is_sidechain ? [folded("サブエージェント", () => [header, ...body()])] : [header, ...body()];
  return h(
    "article",
    {
      class: `mb-3 rounded p-2 ${isUser ? "bg-blue-50" : ""}`,
      attrs: { "data-index": String(message.index), ...(message.uuid ? { "data-uuid": message.uuid } : {}) },
    },
    content,
  );
};

// docs/adr/0014, docs/adr/0016: a session is loaded a page at a time as the view scrolls, newest first:
// older messages are added below, newer ones above.
const NEAR_EDGE_PX = 600;
const conversation = {
  sessionId: null as string | null,
  generation: 0, // bumps when another session is opened, so stale pages are dropped
  range: null as Range | null,
  total: 0,
  loadingUp: false,
  loadingDown: false,
};
const pageStatus = (): HTMLElement =>
  h("p", { class: "py-1 text-xs text-gray-400" }, [
    conversation.range ? `${conversation.range.from}〜${conversation.range.to} / ${conversation.total}` : "",
    conversation.loadingUp || conversation.loadingDown ? "（読み込み中…）" : "",
  ]);
const messagesBox = h("div");
const statusBox = h("div", { class: "sticky top-0 z-10 -mt-4 bg-white/90" });
const refreshStatus = (): void => clear(statusBox, pageStatus());

const loadRange = async (range: Range): Promise<api.MessagePage | null> => {
  const generation = conversation.generation;
  const page = await api.getMessages(conversation.sessionId as string, range.from, range.to - range.from + 1);
  return generation === conversation.generation ? page : null;
};

const nodes = (messages: readonly api.Message[]): Node[] => newestFirst(messages).map(messageNode);

// While the loaded messages do not fill the view, no scroll happens; keep loading until they do.
const fillView = (): void => {
  if (view.scrollHeight - view.clientHeight < NEAR_EDGE_PX) void loadOlder();
};

const loadOlder = async (): Promise<void> => {
  const next = conversation.range && olderRange(conversation.range);
  if (!next || conversation.loadingDown) return;
  conversation.loadingDown = true;
  refreshStatus();
  try {
    const page = await loadRange(next);
    if (!page || !conversation.range) return;
    messagesBox.append(...nodes(page.messages));
    conversation.range = { from: next.from, to: conversation.range.to };
    conversation.total = page.total;
  } catch (e) {
    showError(e);
    return;
  } finally {
    conversation.loadingDown = false;
    refreshStatus();
  }
  fillView();
};

const loadNewer = async (): Promise<void> => {
  const prev = conversation.range && newerRange(conversation.range, conversation.total);
  if (!prev || conversation.loadingUp) return;
  conversation.loadingUp = true;
  refreshStatus();
  try {
    const page = await loadRange(prev);
    if (!page || !conversation.range) return;
    // Keep what the reader was looking at in place while the messages above grow.
    const before = view.scrollHeight;
    messagesBox.prepend(...nodes(page.messages));
    view.scrollTop += view.scrollHeight - before;
    conversation.range = { from: conversation.range.from, to: prev.to };
    conversation.total = page.total;
  } catch (e) {
    showError(e);
  } finally {
    conversation.loadingUp = false;
    refreshStatus();
  }
};

view.addEventListener("scroll", () => {
  if (!conversation.sessionId || !conversation.range) return;
  if (view.scrollTop + view.clientHeight >= view.scrollHeight - NEAR_EDGE_PX) void loadOlder();
  if (view.scrollTop <= NEAR_EDGE_PX) void loadNewer();
});

// `knownTotal` is the message count of the session list (docs/adr/0016); a search hit gives `target`.
const openSession = async (
  sessionId: string,
  target: number | null,
  uuid: string | null,
  knownTotal: number | null,
): Promise<void> => {
  state.selected = sessionId;
  conversation.generation += 1;
  conversation.sessionId = sessionId;
  conversation.range = null;
  conversation.total = 0;
  conversation.loadingUp = false;
  conversation.loadingDown = false;
  const generation = conversation.generation;
  clear(view, h("p", { class: "text-gray-500" }, ["読み込み中…"]));
  try {
    // Around a hit the range does not depend on the total; the newest page uses the list's count,
    // and the backend returns what exists in the range.
    const first = initialRange(target, target === null ? (knownTotal ?? 0) : Number.MAX_SAFE_INTEGER);
    const firstPage = first ? await loadRange(first) : null;
    // The list's count may lag behind the database; then load the newest page again with the real total.
    const stale = target === null && firstPage !== null && firstPage.total !== knownTotal;
    const wanted = stale ? initialRange(null, (firstPage as api.MessagePage).total) : first;
    const page = stale && wanted ? await loadRange(wanted) : firstPage;
    if (generation !== conversation.generation) return;
    if (!wanted || !page || page.total === 0) {
      clear(view, h("p", { class: "text-gray-500" }, ["メッセージがありません"]));
      return;
    }
    conversation.range = { from: wanted.from, to: Math.min(wanted.to, page.total) };
    conversation.total = page.total;
    clear(messagesBox, ...nodes(page.messages));
    clear(view, statusBox, messagesBox);
    refreshStatus();
    const found = uuid
      ? view.querySelector<HTMLElement>(`[data-uuid="${CSS.escape(uuid)}"]`)
      : target !== null
        ? view.querySelector<HTMLElement>(`[data-index="${target}"]`)
        : null;
    if (found) {
      const sidechain = found.querySelector("details");
      if (sidechain && found.firstElementChild === sidechain) sidechain.open = true;
      found.classList.add("ring-2", "ring-amber-400");
      found.scrollIntoView({ block: "center" });
    } else {
      view.scrollTop = 0;
    }
    fillView();
  } catch (e) {
    showError(e);
  }
};

// List
const providerBadge = (provider: string): Node | null =>
  provider === "claude-code" ? null : h("span", { class: "mr-1 rounded bg-gray-100 px-1 text-xs text-gray-600" }, [providerLabel(provider)]);

const sessionItem = (s: api.SessionSummary): Node =>
  h("li", { class: "cursor-pointer p-2 hover:bg-gray-50", on: { click: () => openSession(s.session_id, null, null, s.message_count) } }, [
    h("div", { class: "truncate font-medium" }, [providerBadge(s.provider), s.title ?? s.session_id]),
    h("div", { class: "flex justify-between text-xs text-gray-500" }, [
      h("span", {}, [formatTime(s.last_at)]),
      h("span", {}, [`${s.message_count} 件`]),
    ]),
  ]);

const snippetNode = (snippet: string): Node =>
  h(
    "div",
    { class: "line-clamp-3 whitespace-pre-wrap break-words text-xs" },
    splitSnippet(snippet).map((part) => (part.hit ? h("mark", { class: "bg-amber-200" }, [part.text]) : part.text)),
  );

const hitItem = (hit: api.SearchHit): Node =>
  h(
    "li",
    { class: "cursor-pointer p-2 hover:bg-gray-50", on: { click: () => hit.session_id && openSession(hit.session_id, hit.index, hit.uuid, null) } },
    [
      h("div", { class: "truncate text-xs font-medium" }, [providerBadge(hit.provider), hit.title ?? hit.session_id ?? ""]),
      h("div", { class: "text-xs text-gray-500" }, [`${hit.role ?? ""} ${formatTime(hit.timestamp)}`]),
      snippetNode(hit.snippet),
    ],
  );

const loadPage = async (): Promise<void> => {
  if (state.loading || state.done) return;
  state.loading = true;
  const generation = state.generation;
  try {
    const mode = state.mode;
    const items =
      mode.kind === "sessions"
        ? (await api.listSessions(state.filter, state.offset, PAGE)).map(sessionItem)
        : await api.search(mode.query, state.filter, state.offset, PAGE).then((r) => {
            notice.textContent = r.slow ? "3文字未満の語を含むため、全件を走査しています（遅くなります）。" : "";
            return r.hits.map(hitItem);
          });
    if (generation !== state.generation) return;
    list.append(...items);
    state.offset += items.length;
    state.done = items.length < PAGE;
    if (state.offset === 0) list.append(h("li", { class: "p-2 text-gray-500" }, ["見つかりません"]));
  } catch (e) {
    showError(e);
  } finally {
    if (generation === state.generation) state.loading = false;
  }
};

const resetList = (): void => {
  state.generation += 1;
  state.offset = 0;
  state.done = false;
  state.loading = false;
  notice.textContent = "";
  clear(list);
  list.scrollTop = 0;
  void loadPage();
};

list.addEventListener("scroll", () => {
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 200) void loadPage();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchBox.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = searchBox.value.trim();
    state.mode = query === "" ? { kind: "sessions" } : { kind: "search", query };
    resetList();
  }, SEARCH_DELAY_MS);
});

projectSelect.addEventListener("change", () => {
  state.filter = projectSelect.value === "" ? null : (JSON.parse(projectSelect.value) as Filter);
  resetList();
});

// Reloads the project filter and the list after the database may have changed.
let adminRendered = false;
const showTab = (tab: "browse" | "admin"): void => {
  browse.classList.toggle("hidden", tab !== "browse");
  browse.classList.toggle("flex", tab === "browse");
  admin.classList.toggle("hidden", tab !== "admin");
  searchBox.disabled = tab !== "browse";
  browseTab.className = tabClass(tab === "browse");
  adminTab.className = tabClass(tab === "admin");
  if (tab === "admin" && !adminRendered) {
    adminRendered = true;
    renderAdmin(admin, () => void start().catch(showError));
  }
};
browseTab.addEventListener("click", () => showTab("browse"));
adminTab.addEventListener("click", () => showTab("admin"));

// Rebuilds the project filter, keeping the selected entry when it still exists.
const loadProjects = async (): Promise<void> => {
  const selected = projectSelect.value;
  const projects = await api.listProjects();
  const options = projectOptions(projects).map((o) => JSON.stringify(o.filter));
  clear(
    projectSelect,
    h("option", { attrs: { value: "" } }, ["すべてのプロジェクト"]),
    ...projectOptions(projects).map((o) => h("option", { attrs: { value: JSON.stringify(o.filter) } }, [o.label])),
  );
  projectSelect.value = options.includes(selected) ? selected : "";
  state.filter = projectSelect.value === "" ? null : (JSON.parse(projectSelect.value) as Filter);
};

const showInbox = (): void => {
  void api
    .getSettings()
    .then((v) => {
      const inbox = v.settings.find((s) => s.key === "AI_CHAT_LOGS_CLAUDE_AI_INBOX")?.value;
      scanButton.title = inbox ? `受け取り用のディレクトリ: ${inbox}` : "";
    })
    .catch(() => undefined);
};

scanButton.addEventListener("click", () => {
  scanButton.disabled = true;
  scanStatus.textContent = "取り込み中…";
  scanDetails.classList.add("hidden");
  api
    .scanClaudeAiExports()
    .then(async (r) => {
      scanStatus.textContent = scanMessage(r);
      (scanDetails.querySelector("pre") as HTMLElement).textContent = [...r.imported, r.output].filter((t) => t !== "").join("\n");
      scanDetails.classList.remove("hidden");
      await loadProjects();
      resetList();
    })
    .catch((e) => {
      scanStatus.textContent = typeof e === "object" && e !== null && "kind" in e ? errorText(e as api.StoreError) : String(e);
    })
    .finally(() => {
      scanButton.disabled = false;
    });
});

const start = async (): Promise<void> => {
  const s = await api.status();
  if (s.error) {
    showError(s.error);
    clear(list);
    clear(projectSelect, h("option", { attrs: { value: "" } }, ["すべてのプロジェクト"]));
    showTab("admin");
    return;
  }
  notice.textContent = "";
  await loadProjects();
  showInbox();
  clear(view, h("p", { class: "text-gray-500" }, [`データベース: ${s.path ?? ""}`]));
  resetList();
};

void start().catch(showError);
