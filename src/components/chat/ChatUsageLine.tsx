import React from 'react';
import type { ChatMessageUsage } from '../../types';
import { useTranslation } from '../../hooks/useTranslation';
import { fmt } from '../../lib/text';
import { formatNumber, formatUsd } from '../../lib/format';
import { messageCost, useOpenRouterPrices } from '../../lib/modelPricing';
import { Tooltip } from '../ui';

/** Usage line under an assistant answer: token count plus cost (OpenRouter) or "local · free". */
const ChatUsageLine: React.FC<{ usage: ChatMessageUsage }> = ({ usage }) => {
  const { t, locale } = useTranslation();
  const needsPrices = usage.provider === 'openrouter' && usage.costUsd === undefined;
  const prices = useOpenRouterPrices(needsPrices);
  const cost = messageCost(usage, prices);

  const total = usage.promptTokens + usage.completionTokens;
  const parts = [fmt(t.chat.tokens, { count: total })];
  if (usage.provider === 'ollama') parts.push(t.chat.localFree);
  else if (cost) {
    const amount = formatUsd(cost.usd, locale);
    parts.push(cost.estimated ? fmt(t.chat.costEstimated, { cost: amount }) : amount);
  }

  // "Token" means nothing on its own, so the tooltip says what the number counts first.
  const breakdown = `${t.chat.tokensHint} ${fmt(t.chat.tokenBreakdown, {
    prompt: formatNumber(usage.promptTokens, locale),
    completion: formatNumber(usage.completionTokens, locale),
  })}`;

  // Focusable, so the breakdown is reachable without a mouse; the tooltip also describes it.
  return (
    <Tooltip content={breakdown}>
      <p tabIndex={0} className="rounded-sm text-xs text-fg-muted">
        {parts.join(' · ')}
      </p>
    </Tooltip>
  );
};

export default ChatUsageLine;
