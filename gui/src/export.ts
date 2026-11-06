// docs/adr/0026: the default file name of an exported session.
export const exportFileName = (title: string | null, sessionId: string): string =>
  `${title ? title.replace(/[/:]/g, "-") : sessionId}.md`;
