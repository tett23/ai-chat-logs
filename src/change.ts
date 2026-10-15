export type Change = "unchanged" | "appended" | "rewritten";

export type ChangeInput = {
  size: number;
  consumedBytes: number;
  storedHead: string | null;
  currentHead: string | null;
};

// docs/adr/0001: a file is rewritten when it shrank or its consumed head differs.
export const detectChange = ({ size, consumedBytes, storedHead, currentHead }: ChangeInput): Change =>
  size < consumedBytes || storedHead !== currentHead ? "rewritten" : size === consumedBytes ? "unchanged" : "appended";
