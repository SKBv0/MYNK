import type { SynthesisItem } from '../services/aiService';
import type { Resource } from '../types';

export { buildSynthesisRequest } from '../services/aiService';

export const toSynthesisItem = (resource: Resource): SynthesisItem => ({
  title: resource.title,
  description: resource.description,
  categoryId: resource.categoryId,
  tags: resource.tags,
  summary: resource.summary,
  url: resource.url,
});

export interface SynthesisSource {
  id: string;
  title: string;
  url: string;
}

/** The report text plus a numbered source list, so copied `[#n]` citations still resolve. */
export const withSourceList = (
  text: string,
  sources: SynthesisSource[],
  heading: string,
): string =>
  sources.length === 0
    ? text
    : [
        text.trimEnd(),
        '',
        `## ${heading}`,
        '',
        ...sources.map((source, index) => `${index + 1}. ${source.title} <${source.url}>`),
      ].join('\n');
