// docs/adr/0025: a size in bytes in units of 1000, as macOS's Finder shows it.
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export const formatSize = (bytes: number): string => {
  const exponent = Math.min(UNITS.length - 1, bytes < 1000 ? 0 : Math.floor(Math.log10(bytes) / 3));
  return exponent === 0 ? `${bytes} B` : `${(bytes / 1000 ** exponent).toFixed(2)} ${UNITS[exponent]}`;
};
