import { useAppStore } from '../store';
import { activeCollectionOf } from '../store/selectors';
import { locationTitle, scopeName } from '../lib/nav';
import { useTranslation } from './useTranslation';

/** Same location-title table the sidebar and command palette use. */
export const useLocationTitle = (): string => {
  const { t } = useTranslation();
  const page = useAppStore((s) => s.page);
  const viewMode = useAppStore((s) => s.viewMode);
  const scope = useAppStore((s) => s.scope);
  const collection = useAppStore(activeCollectionOf);
  return locationTitle(page, viewMode, scopeName(scope, collection, t), t);
};
