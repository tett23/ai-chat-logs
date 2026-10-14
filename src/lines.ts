const NEWLINE = 0x0a;
const decoder = new TextDecoder("utf-8");

export type SplitResult = { lines: string[]; consumed: number };

// docs/adr/0001: take bytes up to the last newline; the rest is a partial line left for the next run.
export const splitCompleteLines = (bytes: Uint8Array): SplitResult => {
  const consumed = bytes.lastIndexOf(NEWLINE) + 1;
  const lines =
    consumed === 0
      ? []
      : decoder
          .decode(bytes.subarray(0, consumed - 1))
          .split("\n")
          .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, consumed };
};
