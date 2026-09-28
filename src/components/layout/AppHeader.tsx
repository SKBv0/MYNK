import React from 'react';
import {
  BrainCircuit,
  Command,
  Folder,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  Search,
  Star,
  Upload,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { activeCollectionOf } from '../../store/selectors';
import { useTranslation } from '../../hooks/useTranslation';
import { VIEW_MODES, scopeName, viewLabel, type ViewMode } from '../../lib/nav';
import { modifierKeyLabel } from '../../lib/platform';
import { fmt } from '../../lib/text';
import { VIEW_ICONS } from './navIcons';
import { Button, IconButton, Input, Kbd, Menu, SegmentedControl, type MenuItem } from '../ui';

const AppHeader: React.FC = () => {
  const { t } = useTranslation();
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const page = useAppStore((s) => s.page);
  const viewMode = useAppStore((s) => s.viewMode);
  const scope = useAppStore((s) => s.scope);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setScope = useAppStore((s) => s.setScope);
  const goToPage = useAppStore((s) => s.goToPage);
  const openSettings = useAppStore((s) => s.openSettings);
  const openModal = useAppStore((s) => s.openModal);
  const batchCount = useAppStore((s) => s.batchSelectedIds.length);
  const activeCollection = useAppStore(activeCollectionOf);

  // The scope filters only the library; elsewhere the chip would claim a filter that is not applied.
  const scopeLabel = page === 'library' ? scopeName(scope, activeCollection, t) : null;
  const ScopeIcon = scope === 'favorites' ? Star : Folder;

  const menuItems: MenuItem[] = [
    {
      id: 'synthesis',
      label: t.header.synthesis,
      icon: BrainCircuit,
      disabled: batchCount === 0,
      description:
        batchCount === 0 ? fmt(t.header.synthesisDisabled, { mod: modifierKeyLabel() }) : undefined,
      onSelect: () => openModal('synthesis'),
    },
    {
      id: 'chat',
      label: t.header.globalChat,
      icon: MessageSquareText,
      onSelect: () => openModal('globalChat'),
    },
    {
      id: 'import',
      label: t.header.import,
      icon: Upload,
      onSelect: () => openSettings('data'),
    },
    {
      id: 'palette',
      label: t.header.palette,
      icon: Command,
      shortcut: `${modifierKeyLabel()} K`,
      onSelect: () => openModal('palette'),
    },
  ];

  return (
    <header
      data-chrome
      className="z-header flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle bg-surface-1 px-4 xl:px-6"
    >
      <div role="search" className="min-w-0 max-w-xl flex-1">
        <Input
          type="search"
          label={t.header.search}
          hideLabel
          icon={Search}
          placeholder={
            scopeLabel ? fmt(t.header.searchIn, { name: scopeLabel }) : t.header.searchPlaceholder
          }
          value={searchQuery}
          onChange={(event) => {
            setSearchQuery(event.target.value);
            if (page !== 'library') goToPage('library');
          }}
          onKeyDown={(event) => {
            // Escape clears a non-empty query and stops there, so nothing around the field reacts.
            if (event.key !== 'Escape' || !searchQuery) return;
            event.preventDefault();
            event.stopPropagation();
            setSearchQuery('');
          }}
          leading={
            scopeLabel ? (
              <span className="flex h-7 max-w-40 shrink-0 items-center gap-1 rounded-sm bg-accent-soft pl-2 text-xs font-medium text-accent-text">
                <ScopeIcon size={12} aria-hidden className="shrink-0" />
                <span className="truncate">
                  {/* Full sentence for assistive tech; the chip shows only the name. */}
                  <span className="sr-only">{fmt(t.header.scopeLabel, { name: scopeLabel })}</span>
                  <span aria-hidden>{scopeLabel}</span>
                </span>
                <IconButton
                  label={t.header.clearScope}
                  icon={X}
                  size="xs"
                  className="text-accent-text hover:bg-accent/20 hover:text-accent-text"
                  onClick={() => setScope('all')}
                />
              </span>
            ) : null
          }
          trailing={
            searchQuery ? (
              <IconButton
                label={t.header.clearSearch}
                icon={X}
                size="xs"
                onClick={() => setSearchQuery('')}
              />
            ) : (
              <Kbd className="hidden lg:inline-flex">{`${modifierKeyLabel()} K`}</Kbd>
            )
          }
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <SegmentedControl<ViewMode>
          label={t.header.viewSwitcher}
          value={page === 'library' ? viewMode : null}
          onChange={setViewMode}
          options={VIEW_MODES.map((mode) => ({
            value: mode,
            label: viewLabel(mode, t),
            icon: VIEW_ICONS[mode],
          }))}
          labelClassName="hidden 2xl:inline"
        />
        <Button variant="primary" icon={Plus} onClick={() => openModal('addLink')}>
          {t.common.addNew}
        </Button>
        <Menu
          label={t.common.moreActions}
          items={menuItems}
          trigger={(props) => (
            <IconButton {...props} label={t.common.moreActions} icon={MoreHorizontal} />
          )}
        />
      </div>
    </header>
  );
};

export default AppHeader;
