import { describe, expect, it } from 'vitest';
import { translations } from '../translations';
import { CATEGORY_IDS } from '../services/ipcTypes';

describe('category labels', () => {
  it('exist for every category id in both languages', () => {
    for (const id of CATEGORY_IDS) {
      expect(translations.en.categories[id]).toBeTruthy();
      expect(translations.tr.categories[id]).toBeTruthy();
    }
  });
});
