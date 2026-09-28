import type { UiSlice } from './slices/ui';
import type { LibrarySlice } from './slices/library';
import type { CollectionsSlice } from './slices/collections';
import type { SelectionSlice } from './slices/selection';
import type { ChatsSlice } from './slices/chats';
import type { JobsSlice } from './slices/jobs';
import type { ToastsSlice } from './slices/toasts';

export type AppState = UiSlice &
  LibrarySlice &
  CollectionsSlice &
  SelectionSlice &
  ChatsSlice &
  JobsSlice &
  ToastsSlice;
