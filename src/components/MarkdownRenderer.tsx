import React, { useMemo } from 'react';
import { openExternalUrl } from '../services/aiService';
import { reportError } from '../lib/errors';
import { parseBlocks } from '../lib/markdown';
import { fmt } from '../lib/text';
import { useTranslation } from '../hooks/useTranslation';
import { Prose } from './ui';

/** Small, dependency-free Markdown renderer: headings, lists, code, bold/italic, links, citations. */

interface MarkdownRendererProps {
  text: string;
  /** Called with the 1-based citation number when a `[#n]` chip is clicked. */
  onCitation?: ((index: number) => void) | undefined;
  /** Inline node appended to the end of the last text block (e.g. a streaming cursor). */
  trailing?: React.ReactNode;
}

// Underscore emphasis needs a non-word character on both sides, so `snake_case` stays intact;
// a link target may hold balanced parentheses, as in `..._(film)`.
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_]))|(\[#\d+\])|(\[[^\]]+\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\))/gu;

// Every activation goes to the system browser, not the webview.
const openLink = (event: React.MouseEvent, href: string) => {
  event.preventDefault();
  if (event.type === 'auxclick' && event.button !== 1) return;
  openExternalUrl(href).catch((error: unknown) => reportError(error, 'markdown.openLink'));
};

interface InlineContext {
  onCitation?: ((index: number) => void) | undefined;
  citationLabel: string;
}

const renderInline = (text: string, keyPrefix: string, ctx: InlineContext): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(INLINE.source, INLINE.flags);
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${match.index}`;
    const [token] = match;
    if (match[1]) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key, ctx)}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key, ctx)}</em>);
    } else if (match[4]) {
      const index = Number(token.slice(2, -1));
      nodes.push(
        ctx.onCitation ? (
          <button
            key={key}
            type="button"
            onClick={() => ctx.onCitation?.(index)}
            aria-label={fmt(ctx.citationLabel, { index })}
            className="mx-0.5 inline-flex items-center rounded-sm bg-accent-soft px-1.5 align-baseline text-sm font-semibold text-accent-text hover:bg-accent/20"
          >
            #{index}
          </button>
        ) : (
          <span key={key} className="text-sm font-semibold text-accent-text">
            {token}
          </span>
        ),
      );
    } else if (match[5] && match[6]) {
      const label = token.slice(1, token.indexOf(']('));
      const href = match[6];
      nodes.push(
        <a
          key={key}
          href={href}
          onClick={(event) => openLink(event, href)}
          onAuxClick={(event) => openLink(event, href)}
        >
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ text, onCitation, trailing }) => {
  const { t } = useTranslation();
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const ctx: InlineContext = { onCitation, citationLabel: t.chat.citation };
  const lastBlock = blocks[blocks.length - 1];
  // A cursor after a code block would land inside <pre>; it goes after the blocks instead.
  const trailingInline = lastBlock && lastBlock.type !== 'code' ? trailing : null;

  return (
    <Prose>
      {blocks.map((block, i) => {
        const key = `b-${i}`;
        const tail = i === blocks.length - 1 ? trailingInline : null;
        switch (block.type) {
          case 'heading': {
            const Heading = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
            return (
              <Heading key={key}>
                {renderInline(block.text, key, ctx)}
                {tail}
              </Heading>
            );
          }
          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag key={key}>
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>
                    {renderInline(item, `${key}-${j}`, ctx)}
                    {j === block.items.length - 1 ? tail : null}
                  </li>
                ))}
              </ListTag>
            );
          }
          case 'code':
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          default:
            return (
              <p key={key}>
                {renderInline(block.text, key, ctx)}
                {tail}
              </p>
            );
        }
      })}
      {trailing && !trailingInline ? <p>{trailing}</p> : null}
    </Prose>
  );
};

export default MarkdownRenderer;
