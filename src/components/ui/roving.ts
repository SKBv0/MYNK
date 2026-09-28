/** Next index for a roving-tabindex widget, or `null` when the key is not a navigation key. */
export const rovingIndex = (
  key: string,
  current: number,
  enabled: readonly boolean[],
  orientation: 'both' | 'horizontal' | 'vertical' = 'both',
): number | null => {
  const count = enabled.length;
  if (count === 0) return null;
  const forward =
    (orientation !== 'vertical' && key === 'ArrowRight') ||
    (orientation !== 'horizontal' && key === 'ArrowDown');
  const backward =
    (orientation !== 'vertical' && key === 'ArrowLeft') ||
    (orientation !== 'horizontal' && key === 'ArrowUp');

  const step = (from: number, delta: number): number | null => {
    let index = from;
    for (let i = 0; i < count; i += 1) {
      index = (index + delta + count) % count;
      if (enabled[index]) return index;
    }
    return null;
  };

  if (forward) return step(current, 1);
  if (backward) return step(current, -1);
  if (key === 'Home') return step(-1, 1);
  if (key === 'End') return step(count, -1);
  return null;
};
