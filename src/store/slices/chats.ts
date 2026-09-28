import type { StateCreator } from 'zustand';
import type { ChatKey, ChatMessage } from '../../types';
import type { AppState } from '../state';
import { copyChats, trimChat } from '../model';

export interface ChatsSlice {
  /** Chat threads keyed by resource id or `'global'`; each capped at the last 100 messages. */
  chats: Record<ChatKey, ChatMessage[]>;
  appendChatMessage: (key: ChatKey, message: ChatMessage) => void;
  clearChat: (key: ChatKey) => void;
}

export const createChatsSlice: StateCreator<AppState, [], [], ChatsSlice> = (set) => ({
  chats: copyChats(),
  appendChatMessage: (key, message) =>
    set((state) => {
      const chats = copyChats(state.chats);
      chats[key] = trimChat([...(chats[key] ?? []), message]);
      return { chats };
    }),
  clearChat: (key) =>
    set((state) => {
      if (!Object.hasOwn(state.chats, key)) return state;
      const chats = copyChats(state.chats);
      delete chats[key];
      return { chats };
    }),
});
