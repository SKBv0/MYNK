import { openExternalUrl } from '../services/aiService';
import { getT, useAppStore } from '../store';
import type { Resource } from '../types';
import { copyToClipboard, reportError } from './errors';

/** Opens the resource in the system browser and records `lastOpenedAt`. */
export const openResource = async (resource: Pick<Resource, 'id' | 'url'>): Promise<void> => {
  try {
    await openExternalUrl(resource.url);
    useAppStore.getState().markOpened(resource.id);
  } catch (error) {
    reportError(error, 'openResource');
  }
};

const resourceAsMarkdown = (resource: Resource, insightsLabel: string): string => {
  const lines = [`### [${resource.title}](${resource.url})`];
  if (resource.description) lines.push('', resource.description);
  if (resource.summary.length > 0) {
    lines.push('', `**${insightsLabel}:**`, ...resource.summary.map((line) => `- ${line}`));
  }
  return lines.join('\n');
};

export const copyResourceMarkdown = (resource: Resource): Promise<boolean> => {
  const t = getT();
  return copyToClipboard(resourceAsMarkdown(resource, t.card.keyInsights), t.card.markdownCopied);
};
