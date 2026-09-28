/** OpenRouter price list for the chat cost indicator; fetched at most once per session. */
import { useEffect, useState } from 'react';
import { listOpenRouterModels } from '../services/aiService';
import type { ModelInfo } from '../services/ipcTypes';
import type { ChatMessageUsage } from '../types';

export type ModelPrices = ReadonlyMap<string, ModelInfo>;

let pricesPromise: Promise<ModelPrices> | null = null;
let loadedPrices: ModelPrices | null = null;

/** Session-cached OpenRouter model list keyed by model id. */
export const loadOpenRouterPrices = (
  load: () => Promise<ModelInfo[]> = listOpenRouterModels,
): Promise<ModelPrices> => {
  if (!pricesPromise) {
    pricesPromise = load().then(
      (models) => {
        loadedPrices = new Map(models.map((model) => [model.id, model]));
        return loadedPrices;
      },
      (error: unknown) => {
        pricesPromise = null;
        throw error;
      },
    );
  }
  return pricesPromise;
};

/** Test hook: forgets the cached list. */
export const resetOpenRouterPricesForTests = (): void => {
  pricesPromise = null;
  loadedPrices = null;
};

/** USD estimate from list prices, or `undefined` when the model has no known price. */
export const estimateCostUsd = (
  usage: Pick<ChatMessageUsage, 'promptTokens' | 'completionTokens'>,
  model: ModelInfo | undefined,
): number | undefined => {
  if (!model) return undefined;
  const { promptPricePerMTok, completionPricePerMTok } = model;
  if (promptPricePerMTok === undefined && completionPricePerMTok === undefined) return undefined;
  return (
    (usage.promptTokens * (promptPricePerMTok ?? 0)) / 1e6 +
    (usage.completionTokens * (completionPricePerMTok ?? 0)) / 1e6
  );
};

export interface MessageCost {
  usd: number;
  /** True when estimated from list prices; false when the provider reported it. */
  estimated: boolean;
}

/** Cost of an answer: the provider-reported value, else the list-price estimate. */
export const messageCost = (
  usage: ChatMessageUsage,
  prices: ModelPrices | null,
): MessageCost | null => {
  if (usage.provider !== 'openrouter') return null;
  if (usage.costUsd !== undefined) return { usd: usage.costUsd, estimated: false };
  const estimate = estimateCostUsd(usage, usage.model ? prices?.get(usage.model) : undefined);
  return estimate === undefined ? null : { usd: estimate, estimated: true };
};

/** Loads the price list once when `enabled` (an OpenRouter answer without reported cost). */
export const useOpenRouterPrices = (enabled: boolean): ModelPrices | null => {
  const [prices, setPrices] = useState<ModelPrices | null>(loadedPrices);
  useEffect(() => {
    if (!enabled || loadedPrices) return;
    let alive = true;
    loadOpenRouterPrices()
      .then((loaded) => {
        if (alive) setPrices(loaded);
      })
      .catch((error: unknown) => {
        // Without prices the usage line shows only token counts.
        console.warn('[MYNK] OpenRouter price list unavailable:', error);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return prices ?? loadedPrices;
};
