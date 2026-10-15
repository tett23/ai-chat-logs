// docs/adr/0006: entries of the project filter.
export type Project = { provider: string; cwd: string | null; session_count: number };
export type Filter = { provider: string; cwd: string | null };
export type ProjectOption = { label: string; filter: Filter };

const LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-cowork": "Cowork",
  "claude-ai": "claude.ai",
};

export const providerLabel = (provider: string): string => LABELS[provider] ?? provider;

// Claude Code projects are listed by cwd; every other provider is one entry. Order follows the input.
export const projectOptions = (projects: readonly Project[]): ProjectOption[] => {
  const totals = new Map<string, number>();
  projects
    .filter((p) => p.provider !== "claude-code")
    .forEach((p) => totals.set(p.provider, (totals.get(p.provider) ?? 0) + p.session_count));
  const seen = new Set<string>();
  return projects.flatMap((p): ProjectOption[] => {
    if (p.provider === "claude-code") {
      return p.cwd === null ? [] : [{ label: `${p.cwd}（${p.session_count}）`, filter: { provider: p.provider, cwd: p.cwd } }];
    }
    if (seen.has(p.provider)) return [];
    seen.add(p.provider);
    return [{ label: `${providerLabel(p.provider)}（${totals.get(p.provider)}）`, filter: { provider: p.provider, cwd: null } }];
  });
};
