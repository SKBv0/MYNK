import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Clock,
  Folder,
  LayoutGrid,
  Library,
  Network,
  Settings,
  Sparkles,
  Star,
} from 'lucide-react';
import type { Page, ViewMode } from '../../lib/nav';

export const PAGE_ICONS: Record<Page, LucideIcon> = {
  library: Library,
  collections: Folder,
  health: Activity,
  settings: Settings,
};

export const VIEW_ICONS: Record<ViewMode, LucideIcon> = {
  grid: LayoutGrid,
  graph: Network,
  timeline: Clock,
  feed: Sparkles,
};

export const FAVORITES_ICON: LucideIcon = Star;
