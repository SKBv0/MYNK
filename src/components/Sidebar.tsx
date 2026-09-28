import React, { useMemo, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Folder, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';
import { formatNumber } from '../lib/format';
import { useResolvedTheme } from '../hooks/useThemeVars';
import type { Language } from '../translations';
import { useAppStore } from '../store';
import { countCollectionMembers } from '../store/selectors';
import { sameScope, type Page, type Scope } from '../lib/nav';
import { ACCENTS, accentTokens, type ThemeMode } from '../lib/theme';
import { formatRatio } from '../lib/color';
import { fmt } from '../lib/text';
import { FAVORITES_ICON, PAGE_ICONS } from './layout/navIcons';
import { IconButton, SegmentedControl, Tooltip, cx } from './ui';
import { rovingIndex } from './ui/roving';

const COLLECTION_SHORTCUTS = 5;

interface NavLinkProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  count?: number | undefined;
  /** Count shown as a warning (e.g. broken links). */
  alert?: boolean;
  nested?: boolean;
}

const NavLink: React.FC<NavLinkProps> = ({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
  count,
  alert = false,
  nested = false,
}) => {
  const { locale } = useTranslation();
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      className={cx(
        'group relative flex w-full items-center gap-3 rounded-md text-left transition-colors duration-fast',
        collapsed ? 'h-10 justify-center' : nested ? 'h-8 px-2.5' : 'h-9 px-2.5',
        active
          ? 'bg-surface-active font-medium text-fg'
          : 'text-fg-secondary hover:bg-surface-hover hover:text-fg',
        // The current location gets a single accent stripe.
        active &&
          'before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent',
      )}
    >
      <Icon
        size={nested ? 16 : 18}
        aria-hidden
        className={cx(
          'shrink-0',
          active ? 'text-accent-text' : 'text-fg-muted group-hover:text-fg-secondary',
        )}
      />
      {!collapsed && (
        <>
          <span className={cx('min-w-0 flex-1 truncate', nested ? 'text-sm' : 'text-base')}>
            {label}
          </span>
          {count !== undefined && (
            <span
              className={cx(
                'shrink-0 text-xs tabular-nums',
                alert ? 'font-semibold text-danger' : 'text-fg-muted',
              )}
            >
              {formatNumber(count, locale)}
            </span>
          )}
        </>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} side="right" describe={false}>
      {button}
    </Tooltip>
  ) : (
    button
  );
};

/** A radio group of accent swatches, each with its measured contrast. */
const AccentPicker: React.FC = () => {
  const { t } = useTranslation();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const resolved = useResolvedTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = ACCENTS.findIndex((a) => a.value.toLowerCase() === theme.accent.toLowerCase());
  // An accent outside the list checks nothing, but the group still needs one tab stop.
  const tabStop = Math.max(0, selected);

  const choose = (index: number) => {
    const option = ACCENTS[index];
    if (!option) return;
    setTheme({ ...theme, accent: option.value });
  };

  return (
    <div
      role="radiogroup"
      aria-label={t.sidebar.accent}
      // Spread across the panel like the full-width segmented controls above and below it.
      className="flex items-center justify-between gap-2"
    >
      {ACCENTS.map((accent, index) => {
        const checked = index === selected;
        const tokens = accentTokens(accent.value, resolved);
        const name = fmt(t.sidebar.accentOption, {
          name: t.sidebar.accents[accent.id],
          ratio: formatRatio(tokens.ratio),
        });
        return (
          <Tooltip key={accent.id} content={name} describe={false}>
            <button
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={name}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => choose(index)}
              onKeyDown={(event) => {
                const next = rovingIndex(
                  event.key,
                  index,
                  ACCENTS.map(() => true),
                );
                if (next === null) return;
                event.preventDefault();
                refs.current[next]?.focus();
                choose(next);
              }}
              className={cx(
                'h-6 w-6 rounded-full border-2 transition-transform duration-fast hover:scale-110',
                checked ? 'border-fg' : 'border-transparent',
              )}
              style={{ backgroundColor: accent.value }}
            />
          </Tooltip>
        );
      })}
    </div>
  );
};

const Appearance: React.FC = () => {
  const { t, lang, setLang } = useTranslation();
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);

  const modes: { value: ThemeMode; label: string; icon: LucideIcon }[] = [
    { value: 'dark', label: t.sidebar.themeModes.dark, icon: Moon },
    { value: 'light', label: t.sidebar.themeModes.light, icon: Sun },
    { value: 'system', label: t.sidebar.themeModes.system, icon: Monitor },
  ];
  const languages: { value: Language; label: string }[] = [
    { value: 'en', label: 'EN' },
    { value: 'tr', label: 'TR' },
  ];

  return (
    <section aria-labelledby="sidebar-appearance" className="space-y-3 px-3 pb-3">
      <h2 id="sidebar-appearance" className="text-overline">
        {t.sidebar.appearance}
      </h2>
      <SegmentedControl
        label={t.sidebar.theme}
        value={themeMode}
        onChange={setThemeMode}
        options={modes}
        iconOnly
        fullWidth
        size="sm"
      />
      <AccentPicker />
      <SegmentedControl
        label={t.sidebar.language}
        value={lang}
        onChange={setLang}
        options={languages.map((l) => ({ ...l, hint: t.sidebar.languages[l.value] }))}
        fullWidth
        size="sm"
      />
    </section>
  );
};

const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const page = useAppStore((s) => s.page);
  const scope = useAppStore((s) => s.scope);
  const isCollapsed = useAppStore((s) => s.isSidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const goToPage = useAppStore((s) => s.goToPage);
  const setScope = useAppStore((s) => s.setScope);
  const openCollection = useAppStore((s) => s.openCollection);
  const resources = useAppStore((s) => s.resources);
  const collections = useAppStore((s) => s.collections);

  const shortcuts = useMemo(() => collections.slice(0, COLLECTION_SHORTCUTS), [collections]);
  const counts = useMemo(() => {
    // One cheap pass for the two numbers shown here, instead of the heavier healthSummary().
    let favorites = 0;
    let broken = 0;
    for (const r of resources) {
      if (r.isFavorite) favorites += 1;
      if (r.health.status === 'dead') broken += 1;
    }
    const byCollection = new Map<string, number>();
    for (const c of shortcuts) byCollection.set(c.id, countCollectionMembers(c, resources));
    return { favorites, byCollection, broken };
  }, [resources, shortcuts]);

  const isScope = (target: Scope) => page === 'library' && sameScope(scope, target);
  const isPage = (target: Page) => page === target;

  return (
    <aside
      data-chrome
      className={cx(
        'z-sidebar flex h-full shrink-0 flex-col border-r border-line-subtle bg-surface-1 transition-[width] duration-base ease-out',
        isCollapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
    >
      <div
        className={cx(
          'flex h-14 shrink-0 items-center border-b border-line-subtle',
          isCollapsed ? 'justify-center' : 'justify-between pl-4 pr-2',
        )}
      >
        {!isCollapsed && (
          <div className="min-w-0">
            <p className="font-display text-lg font-bold leading-none text-accent-text">MYNK</p>
            <p className="mt-1 truncate text-xs text-fg-muted">{t.sidebar.tagline}</p>
          </div>
        )}
        <IconButton
          label={isCollapsed ? t.sidebar.expand : t.sidebar.collapse}
          icon={isCollapsed ? PanelLeftOpen : PanelLeftClose}
          onClick={toggleSidebar}
          tooltipSide="right"
          aria-expanded={!isCollapsed}
        />
      </div>

      <nav aria-label={t.nav.mainLabel} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          <li>
            <NavLink
              icon={PAGE_ICONS.library}
              label={t.nav.pages.library}
              active={isScope('all')}
              collapsed={isCollapsed}
              onClick={() => setScope('all')}
              count={resources.length}
            />
            <ul
              aria-label={t.nav.collectionShortcuts}
              className={cx(
                'mt-0.5 space-y-0.5',
                !isCollapsed && 'ml-4 border-l border-line-subtle pl-2',
              )}
            >
              <li>
                <NavLink
                  icon={FAVORITES_ICON}
                  label={t.nav.favorites}
                  active={isScope('favorites')}
                  collapsed={isCollapsed}
                  onClick={() => setScope('favorites')}
                  count={counts.favorites}
                  nested={!isCollapsed}
                />
              </li>
              {!isCollapsed &&
                shortcuts.map((collection) => (
                  <li key={collection.id}>
                    <NavLink
                      icon={Folder}
                      label={collection.name}
                      active={isScope({ collectionId: collection.id })}
                      collapsed={false}
                      onClick={() => openCollection(collection.id)}
                      count={counts.byCollection.get(collection.id)}
                      nested
                    />
                  </li>
                ))}
              {!isCollapsed && collections.length > COLLECTION_SHORTCUTS && (
                <li>
                  <button
                    type="button"
                    onClick={() => goToPage('collections')}
                    className="h-7 w-full rounded-md px-2.5 text-left text-sm text-fg-muted hover:bg-surface-hover hover:text-fg"
                  >
                    {fmt(t.nav.moreCollections, {
                      count: collections.length - COLLECTION_SHORTCUTS,
                    })}
                  </button>
                </li>
              )}
            </ul>
          </li>
          <li className="pt-2">
            <NavLink
              icon={PAGE_ICONS.collections}
              label={t.nav.pages.collections}
              active={isPage('collections')}
              collapsed={isCollapsed}
              onClick={() => goToPage('collections')}
              count={collections.length}
            />
          </li>
          <li>
            <NavLink
              icon={PAGE_ICONS.health}
              label={t.nav.pages.health}
              active={isPage('health')}
              collapsed={isCollapsed}
              onClick={() => goToPage('health')}
              count={counts.broken > 0 ? counts.broken : undefined}
              alert
            />
          </li>
        </ul>
      </nav>

      <div className="shrink-0 border-t border-line-subtle pt-3">
        {!isCollapsed && <Appearance />}
        <div className="px-2 pb-3">
          <NavLink
            icon={PAGE_ICONS.settings}
            label={t.nav.pages.settings}
            active={isPage('settings')}
            collapsed={isCollapsed}
            onClick={() => goToPage('settings')}
          />
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
