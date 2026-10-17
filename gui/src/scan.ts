// docs/adr/0010: the short result shown under the button on the browse screen.
export type ScanResult = {
  imported: string[];
  scan_exit_code: number | null;
  exit_code: number | null;
  output: string;
};

export const scanMessage = (r: ScanResult): string => {
  const failed = [r.scan_exit_code, r.exit_code].find((code) => code !== 0);
  if (failed !== undefined) return `失敗しました（終了コード ${failed ?? "なし"}）`;
  return r.imported.length > 0 ? `claude.ai のエクスポートを ${r.imported.length} 件取り込みました` : "新しいエクスポートはありません";
};
