/** ISO timestamp for `<time dateTime>`, or `undefined` for a value `Date` cannot represent. */
export const isoDateTime = (timestamp: number): string | undefined => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/** Content-derived React keys for a list of text lines; repeats get an occurrence suffix. */
export const keyedLines = (lines: readonly string[]): { key: string; line: string }[] => {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = seen.get(line) ?? 0;
    seen.set(line, occurrence + 1);
    return { key: occurrence === 0 ? line : `${line}#${occurrence}`, line };
  });
};
