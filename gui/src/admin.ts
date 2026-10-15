// docs/adr/0007: the settings and setup screen.
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api.ts";
import { clear, h } from "./dom.ts";

const LABELS: Record<string, string> = {
  AI_CHAT_LOGS_DB: "データベース",
  CLAUDE_CONFIG_DIR: "Claude Code の設定ディレクトリ",
  AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR: "デスクトップアプリのディレクトリ",
  AI_CHAT_LOGS_CLAUDE_AI_DIR: "claude.ai のエクスポートの保存先",
  AI_CHAT_LOGS_REPO: "このリポジトリ",
  AI_CHAT_LOGS_BUN: "bun",
};

const ORIGINS: Record<api.Origin, string> = {
  environment: "環境変数",
  env_file: ".env",
  config_file: "設定ファイル",
  default: "既定",
};

const section = (title: string, children: Node[]): HTMLElement =>
  h("section", { class: "mb-6" }, [h("h2", { class: "mb-2 text-base font-semibold" }, [title]), ...children]);

const button = (label: string, onClick: () => void): HTMLButtonElement =>
  h(
    "button",
    {
      class: "shrink-0 whitespace-nowrap rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50",
      on: { click: onClick },
    },
    [label],
  );

const message = (text: string, tone: "info" | "error" = "info"): HTMLElement =>
  h("p", { class: `text-sm ${tone === "error" ? "text-red-700" : "text-gray-600"}` }, [text]);

const storeErrorText = (e: unknown): string =>
  typeof e === "object" && e !== null && "kind" in e
    ? (() => {
        const err = e as api.StoreError;
        switch (err.kind) {
          case "not_found":
            return `見つかりません: ${err.path}`;
          case "old_schema":
            return `スキーマが古いです（${err.found}、必要なのは ${err.required}）`;
          case "sqlite":
          case "settings":
            return err.message;
        }
      })()
    : String(e);

// Settings
const settingRow = (setting: api.Setting, onSave: (key: string, value: string | null) => void): HTMLElement => {
  const input = h("input", {
    class: "w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs",
    attrs: { type: "text", value: setting.origin === "config_file" ? (setting.value ?? "") : "", placeholder: setting.value ?? "" },
  });
  const overridden = setting.origin === "environment" || setting.origin === "env_file";
  return h("div", { class: "mb-3" }, [
    h("div", { class: "flex items-baseline justify-between text-sm" }, [
      h("span", { class: "font-medium" }, [LABELS[setting.key] ?? setting.key]),
      h("span", { class: "text-xs text-gray-500" }, [`${setting.key}・${ORIGINS[setting.origin]}`]),
    ]),
    h("div", { class: "mt-1 flex gap-2" }, [
      input,
      button("保存", () => onSave(setting.key, input.value.trim() === "" ? null : input.value.trim())),
    ]),
    h("div", { class: "mt-0.5 font-mono text-xs text-gray-500" }, [`いまの値: ${setting.value ?? "（なし）"}`]),
    overridden ? message(`${ORIGINS[setting.origin]}で決まっているため、設定ファイルに書いても効きません。`, "error") : null,
  ]);
};

const renderSettings = async (container: HTMLElement, onChanged: () => void): Promise<void> => {
  const render = (view: api.SettingsView, note: Node | null = null): void => {
    const save = (key: string, value: string | null) => {
      api
        .saveSetting(key, value)
        .then((v) => {
          render(v, message("保存しました。"));
          onChanged();
        })
        .catch((e) => render(view, message(storeErrorText(e), "error")));
    };
    clear(
      container,
      message(`設定ファイル: ${view.config_path ?? "（場所が分かりません）"}。空にして保存すると既定に戻ります。`),
      ...(view.error ? [message(storeErrorText(view.error), "error")] : []),
      ...(note ? [note] : []),
      ...view.settings.map((s) => settingRow(s, save)),
    );
  };
  render(await api.getSettings());
};

// Environment check
const row = (label: string, value: string, ok: boolean | null = null): HTMLElement =>
  h("tr", {}, [
    h("td", { class: "py-0.5 pr-4 align-top text-gray-600" }, [label]),
    h("td", { class: `py-0.5 font-mono text-xs ${ok === false ? "text-red-700" : ""}` }, [value]),
  ]);

const renderCheck = async (container: HTMLElement): Promise<void> => {
  clear(container, message("検査中…"));
  const c = await api.checkEnvironment();
  const db = c.database;
  const lastRun = db.last_run
    ? `${db.last_run.started_at}（${db.last_run.records_added} 件${db.last_run.errors ? "、失敗あり" : ""}）`
    : "なし";
  clear(
    container,
    h("table", { class: "text-sm" }, [
      h("tbody", {}, [
        ...c.paths.map((p) =>
          row(LABELS[p.key] ?? p.key, `${p.path}（${p.kind === "file" ? "ファイル" : p.kind === "directory" ? "ディレクトリ" : "ありません"}）`, p.kind !== "missing"),
        ),
        row("データベース", db.exists ? (db.error ?? `スキーマの版 ${db.schema_version}`) : "ありません", db.exists && db.error === null),
        row("レコード／セッション", `${db.records ?? "-"} ／ ${db.sessions ?? "-"}`),
        row("最後の取り込み", lastRun),
        row("bun", c.bun.error ?? `${c.bun.path}（${c.bun.detail}）`, c.bun.error === null),
        row("pm2", c.pm2.error ?? c.pm2.path ?? "", c.pm2.error === null),
        row("pm2 の登録", c.pm2_registered === null ? "分かりません" : c.pm2_registered ? "あり" : "なし", c.pm2_registered),
        row("ログイン時の起動（launchd）", c.launch_agent ? "あり" : "なし", c.launch_agent),
      ]),
    ]),
    ...(c.pm2_registered && c.launch_agent ? [] : [message("pm2 の登録は README の「手動で行う作業」を参照してください。")]),
  );
};

// Setup
const renderSetup = (container: HTMLElement, onChanged: () => void): void => {
  const output = h("pre", { class: "mt-2 hidden max-h-64 overflow-auto rounded bg-gray-100 p-2 font-mono text-xs" });
  const status = h("p", { class: "mt-2 text-sm text-gray-600" });
  const buttons: HTMLButtonElement[] = [];
  const run = (label: string, task: () => Promise<api.RunResult | null>) => {
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = `${label}: 実行中…`;
    output.classList.add("hidden");
    task()
      .then((r) => {
        if (r === null) {
          status.textContent = "";
          return;
        }
        status.textContent = `${label}: ${r.exit_code === 0 ? "完了" : `終了コード ${r.exit_code ?? "なし"}`}`;
        output.textContent = r.output;
        output.classList.remove("hidden");
        onChanged();
      })
      .catch((e) => {
        status.textContent = `${label}: ${storeErrorText(e)}`;
      })
      .finally(() => buttons.forEach((b) => (b.disabled = false)));
  };
  buttons.push(
    button("取り込む", () => run("取り込み", api.runSync)),
    button("claude.ai のエクスポートを取り込む", () =>
      run("claude.ai のエクスポートの取り込み", async () => {
        const zip = await open({ multiple: false, directory: false, filters: [{ name: "zip", extensions: ["zip"] }] });
        return typeof zip === "string" ? api.importClaudeAiExport(zip) : null;
      }),
    ),
  );
  clear(
    container,
    message("取り込みは、データベースが無ければ作ってから、履歴の差分を取り込みます。初回は数十秒から数分かかります。"),
    h("div", { class: "mt-2 flex gap-2" }, buttons),
    status,
    output,
  );
};

export const renderAdmin = (container: HTMLElement, onChanged: () => void): void => {
  const settings = h("div");
  const check = h("div");
  const setup = h("div");
  const refreshCheck = () => void renderCheck(check).catch((e) => clear(check, message(storeErrorText(e), "error")));
  const changed = () => {
    refreshCheck();
    onChanged();
  };
  clear(
    container,
    section("設定", [settings]),
    section("環境の検査", [button("再検査", refreshCheck), h("div", { class: "mt-2" }, [check])]),
    section("初期化", [setup]),
  );
  void renderSettings(settings, changed).catch((e) => clear(settings, message(storeErrorText(e), "error")));
  refreshCheck();
  renderSetup(setup, changed);
};
