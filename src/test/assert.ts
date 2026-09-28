/** Element at `index`, failing the test with a clear message when it's missing. */
export const nth = <T>(items: readonly T[], index: number): T => {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`Expected an element at index ${index}, but the list has ${items.length}.`);
  }
  return item;
};
