import { describe, expect, test } from "bun:test";
import { scanMessage } from "../src/scan.ts";

// docs/adr/0010
const result = (imported: string[], scan: number | null, sync: number | null) => ({
  imported,
  scan_exit_code: scan,
  exit_code: sync,
  output: "",
});

describe("scanMessage", () => {
  test("counts the imported exports", () => {
    expect(scanMessage(result(["/a", "/b"], 0, 0))).toBe("claude.ai のエクスポートを 2 件取り込みました");
  });

  test("says when there is nothing new", () => {
    expect(scanMessage(result([], 0, 0))).toBe("新しいエクスポートはありません");
  });

  test("reports a failed scan or import with the exit code", () => {
    expect(scanMessage(result([], 1, 0))).toBe("失敗しました（終了コード 1）");
    expect(scanMessage(result(["/a"], 0, 2))).toBe("失敗しました（終了コード 2）");
    expect(scanMessage(result([], null, 0))).toBe("失敗しました（終了コード なし）");
  });
});
