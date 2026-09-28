import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BrainCircuit,
  FileText,
  MessageSquareText,
  Plus,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { rankResources } from '../store/selectors';
import { sourceLabel } from '../services/resourceMedia';
import { startEnrichmentConfirmed } from '../store/jobs/enrich';
import { PAGES, VIEW_MODES, pageLabel, viewLabel } from '../lib/nav';
import { fmt, normalizeSearchText } from '../lib/text';
import { FAVORITES_ICON, PAGE_ICONS, VIEW_ICONS } from './layout/navIcons';
import { Kbd, Modal, cx } from './ui';

interface PaletteCommand {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Alt+letter shortcut. */
  shortcut?: string;
  run: () => void;
}

type PaletteEntry =
  | { kind: 'command'; group: 'actions' | 'goTo'; command: PaletteCommand }
  | { kind: 'resource'; id: string; title: string; host: string };

const RESOURCE_RESULTS = 8;

/** Go-to letters for the navigation table (Alt+letter). */
const PAGE_SHORTCUTS = { library: 'L', collections: 'C', health: 'H', settings: 'S' } as const;
const VIEW_SHORTCUTS = { grid: 'G', graph: 'M', timeline: 'T', feed: 'U' } as const;

const PaletteBody: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const goToPage = useAppStore((s) => s.goToPage);
  const openSettings = useAppStore((s) => s.openSettings);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setScope = useAppStore((s) => s.setScope);
  const openModal = useAppStore((s) => s.openModal);
  const selectResource = useAppStore((s) => s.selectResource);
  const resources = useAppStore((s) => s.resources);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);

  // Actions plus the navigation table shared with the sidebar and header.
  const commands = useMemo(() => {
    const actions: PaletteCommand[] = [
      {
        id: 'new',
        icon: Plus,
        label: t.palette.newLink,
        shortcut: 'N',
        run: () => openModal('addLink'),
      },
      {
        id: 'import',
        icon: Upload,
        label: t.palette.import,
        shortcut: 'I',
        run: () => openSettings('data'),
      },
      {
        id: 'enrich',
        icon: Sparkles,
        label: t.palette.enrich,
        shortcut: 'E',
        run: () => void startEnrichmentConfirmed(),
      },
      {
        id: 'synthesis',
        icon: BrainCircuit,
        label: t.palette.synthesis,
        shortcut: 'Y',
        run: () => openModal('synthesis'),
      },
      {
        id: 'chat',
        icon: MessageSquareText,
        label: t.palette.chat,
        shortcut: 'B',
        run: () => openModal('globalChat'),
      },
    ];
    const goTo: PaletteCommand[] = [
      ...PAGES.map((page) => ({
        id: `page-${page}`,
        icon: PAGE_ICONS[page],
        label: pageLabel(page, t),
        shortcut: PAGE_SHORTCUTS[page],
        run: () => (page === 'library' ? setScope('all') : goToPage(page)),
      })),
      {
        id: 'favorites',
        icon: FAVORITES_ICON,
        label: t.nav.favorites,
        shortcut: 'F',
        run: () => setScope('favorites'),
      },
      ...VIEW_MODES.map((mode) => ({
        id: `view-${mode}`,
        icon: VIEW_ICONS[mode],
        label: fmt(t.palette.showView, { view: viewLabel(mode, t) }),
        shortcut: VIEW_SHORTCUTS[mode],
        run: () => setViewMode(mode),
      })),
    ];
    return { actions, goTo };
  }, [goToPage, openModal, openSettings, setScope, setViewMode, t]);

  // Ranking a large library runs at a lower priority than the keystroke itself.
  const deferredSearch = useDeferredValue(search);
  const resourceEntries = useMemo<PaletteEntry[]>(
    () =>
      deferredSearch.trim()
        ? rankResources(resources, deferredSearch, RESOURCE_RESULTS).map((r) => ({
            kind: 'resource' as const,
            id: r.id,
            title: r.title,
            host: sourceLabel(r),
          }))
        : [],
    [resources, deferredSearch],
  );

  const entries = useMemo<PaletteEntry[]>(() => {
    // Same normalization as the bookmark search, so "yakinlastir" finds "Yakınlaştır".
    const query = normalizeSearchText(search.trim());
    const matches = (command: PaletteCommand) =>
      !query || normalizeSearchText(command.label).includes(query);
    return [
      ...commands.actions
        .filter(matches)
        .map((command) => ({ kind: 'command' as const, group: 'actions' as const, command })),
      ...commands.goTo
        .filter(matches)
        .map((command) => ({ kind: 'command' as const, group: 'goTo' as const, command })),
      ...(query ? resourceEntries : []),
    ];
  }, [commands, resourceEntries, search]);

  const activeIndex = Math.min(active, Math.max(0, entries.length - 1));
  const allCommands = [...commands.actions, ...commands.goTo];

  // `aria-activedescendant` alone does not scroll the list into view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[id="palette-item-${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, entries]);

  const runEntry = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    // Close first so commands that open another modal are not overridden.
    onClose();
    if (entry.kind === 'command') entry.command.run();
    else selectResource(entry.id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) =>
        entries.length ? (Math.min(i, entries.length - 1) + 1) % entries.length : 0,
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) =>
        entries.length
          ? (Math.min(i, entries.length - 1) - 1 + entries.length) % entries.length
          : 0,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runEntry(entries[activeIndex]);
    } else if (event.altKey && event.code.startsWith('Key')) {
      // Alt+letter shortcuts work while typing (plain letters stay available for search).
      const letter = event.code.slice(3);
      const command = allCommands.find((c) => c.shortcut === letter);
      if (command) {
        event.preventDefault();
        runEntry({ kind: 'command', group: 'actions', command });
      }
    }
  };

  const groupLabel = (entry: PaletteEntry) =>
    entry.kind === 'resource'
      ? t.palette.resources
      : entry.group === 'actions'
        ? t.palette.actions
        : t.palette.goTo;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line-subtle px-4">
        <Search size={18} aria-hidden className="shrink-0 text-fg-muted" />
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-label={t.palette.title}
          aria-activedescendant={entries.length ? `palette-item-${activeIndex}` : undefined}
          placeholder={t.palette.placeholder}
          className="field-control h-14 min-w-0 flex-1 bg-transparent text-md text-fg placeholder:text-fg-muted"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <Kbd>Esc</Kbd>
      </div>

      <div
        ref={listRef}
        id="palette-list"
        role="listbox"
        aria-label={t.palette.title}
        className="max-h-96 overflow-y-auto p-2"
      >
        {entries.length === 0 && (
          <p className="px-3 py-6 text-center text-base text-fg-muted">{t.palette.noResults}</p>
        )}
        {entries.map((entry, index) => {
          const isActive = index === activeIndex;
          const previous = entries[index - 1];
          const showHeader = !previous || groupLabel(previous) !== groupLabel(entry);
          const Icon = entry.kind === 'command' ? entry.command.icon : FileText;
          const key = entry.kind === 'command' ? entry.command.id : entry.id;
          return (
            <React.Fragment key={key}>
              {showHeader && (
                <div role="presentation" className="text-overline px-3 pb-1 pt-3 first:pt-1">
                  {groupLabel(entry)}
                </div>
              )}
              <div
                id={`palette-item-${index}`}
                role="option"
                aria-selected={isActive}
                onMouseMove={() => setActive(index)}
                onClick={() => runEntry(entry)}
                className={cx(
                  'flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2',
                  isActive ? 'bg-surface-active text-fg' : 'text-fg-secondary',
                )}
              >
                <Icon
                  size={16}
                  aria-hidden
                  className={cx('shrink-0', isActive ? 'text-accent-text' : 'text-fg-muted')}
                />
                <span className="min-w-0 flex-1 truncate text-base">
                  {entry.kind === 'command' ? entry.command.label : entry.title}
                </span>
                {entry.kind === 'command' ? (
                  entry.command.shortcut && <Kbd>Alt {entry.command.shortcut}</Kbd>
                ) : (
                  <span className="shrink-0 truncate text-sm text-fg-muted">{entry.host}</span>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      <div className="border-t border-line-subtle bg-surface-2 px-4 py-2.5 text-sm text-fg-muted">
        {t.palette.hint}
      </div>
    </div>
  );
};

/** Ctrl+K command palette: combobox + listbox with sections Actions / Go to / Bookmarks. */
const CommandPalette: React.FC = () => {
  const isOpen = useAppStore((s) => s.activeModal === 'palette');
  const closeModal = useAppStore((s) => s.closeModal);
  const { t } = useTranslation();
  return (
    <Modal
      open={isOpen}
      onClose={closeModal}
      title={t.palette.title}
      hideHeader
      placement="top"
      size="lg"
      padded={false}
    >
      <PaletteBody onClose={closeModal} />
    </Modal>
  );
};

export default CommandPalette;
