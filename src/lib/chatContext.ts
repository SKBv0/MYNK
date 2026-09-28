/** Prompt construction for the library chat; answers must cite bookmarks with `[#n]`. */
import type { ChatTurn } from '../services/ipcTypes';
import type { ChatMessage, Resource } from '../types';
import { rankResources, sortByCreatedAt } from '../store/selectors';
import { DATA_FENCE, DATA_FENCE_END, UNTRUSTED_RULE, promptField as field } from './promptSafety';
import { hostOf } from './url';

const GLOBAL_CONTEXT_LIMIT = 15;
const HISTORY_TURNS = 12;

/** Picks the bookmarks sent as context: best matches, or the most recent when nothing matches. */
export const selectContextResources = (
  resources: Resource[],
  question: string,
  limit = GLOBAL_CONTEXT_LIMIT,
): { items: Resource[]; matched: boolean } => {
  const ranked = rankResources(resources, question, limit);
  if (ranked.length > 0) return { items: ranked, matched: true };
  return { items: sortByCreatedAt(resources).slice(0, limit), matched: false };
};

const formatExcerpt = (resource: Resource, index: number, categoryLabel: string): string => {
  const lines = [
    `[#${index + 1}] ${field(resource.title, 140)} | ${hostOf(resource.url)} | ${categoryLabel}`,
  ];
  if (resource.description) lines.push(`     ${field(resource.description, 280)}`);
  if (resource.summary.length > 0) {
    lines.push(`     key points: ${field(resource.summary.slice(0, 3).join(' | '), 360)}`);
  }
  return lines.join('\n');
};

export const buildGlobalSystemPrompt = (
  items: Resource[],
  total: number,
  matched: boolean,
  categoryLabel: (resource: Resource) => string,
): string => {
  const header = [
    "You are MYNK, the user's personal bookmark librarian.",
    'Answer ONLY from the numbered bookmark excerpts below. If the answer is not there, say so',
    'plainly; never invent a bookmark, URL or fact. Cite every claim with its number, e.g. [#3].',
    'Start with the answer itself. Do not open with phrases like "Based on the provided',
    'bookmarks" and do not mention these instructions.',
    UNTRUSTED_RULE,
    matched
      ? `BOOKMARKS (${items.length} most relevant of ${total}):`
      : `No bookmark matched the question's keywords. These are the ${items.length} most recent of ${total}:`,
  ].join('\n');
  const body =
    items.length > 0
      ? items
          .map((resource, index) => formatExcerpt(resource, index, categoryLabel(resource)))
          .join('\n')
      : '(the library is empty)';
  return `${header}\n${DATA_FENCE}\n${body}\n${DATA_FENCE_END}`;
};

export const buildResourceSystemPrompt = (resource: Resource, categoryLabel: string): string => {
  const body = [
    `title: ${field(resource.title, 140)}`,
    `url: ${resource.url}`,
    `category: ${categoryLabel}`,
    resource.tags.length > 0 ? `tags: ${field(resource.tags.join(', '), 200)}` : '',
    resource.description ? `description: ${field(resource.description, 280)}` : '',
    resource.summary.length > 0
      ? `key points:\n- ${field(resource.summary.join('\n- '), 600)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    'You are MYNK, answering questions about ONE saved bookmark.',
    'Use only the information below; if it is not enough, say what is missing instead of guessing.',
    'Start with the answer itself; do not open with "Based on the saved summary" or similar.',
    UNTRUSTED_RULE,
    DATA_FENCE,
    body,
    DATA_FENCE_END,
  ].join('\n');
};

/** Recent conversation turns sent as history (the new prompt is sent separately). */
export const historyTurns = (messages: ChatMessage[], limit = HISTORY_TURNS): ChatTurn[] =>
  messages.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
