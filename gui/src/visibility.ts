// docs/adr/0024: which blocks and messages the conversation view shows, from the 表示 menu.

export const HIDEABLE = ["thinking", "tool_use", "tool_result"] as const;
export type HideableKind = (typeof HIDEABLE)[number];
export type Shown = Record<HideableKind, boolean>;

export const ALL_SHOWN: Shown = { thinking: true, tool_use: true, tool_result: true };

const isHideable = (kind: string): kind is HideableKind => (HIDEABLE as readonly string[]).includes(kind);

// Text and other blocks (images and the like) cannot be hidden.
export const blockShown = (kind: string, shown: Shown): boolean => !isHideable(kind) || shown[kind];

// A message hidden by the menu has blocks but none of them shown; a highlighted one always shows.
export const messageShown = (kinds: readonly string[], shown: Shown, highlighted: boolean): boolean =>
  highlighted || kinds.length === 0 || kinds.some((kind) => blockShown(kind, shown));

export const serializeShown = (shown: Shown): string => JSON.stringify(shown);

// The saved menu; anything unreadable shows everything.
export const parseShown = (value: string | null): Shown => {
  const parsed: unknown = (() => {
    try {
      return value === null ? null : JSON.parse(value);
    } catch {
      return null;
    }
  })();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ALL_SHOWN;
  const entries = Object.entries(parsed).filter(([kind]) => isHideable(kind));
  if (entries.some(([, v]) => typeof v !== "boolean")) return ALL_SHOWN;
  return { ...ALL_SHOWN, ...Object.fromEntries(entries) };
};
