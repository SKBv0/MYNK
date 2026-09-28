import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  estimateCostUsd,
  loadOpenRouterPrices,
  messageCost,
  resetOpenRouterPricesForTests,
} from './modelPricing';
import { normalizeChatMessage } from '../store/model';
import type { ModelInfo } from '../services/ipcTypes';

const model: ModelInfo = {
  id: 'openai/gpt-x',
  name: 'GPT X',
  promptPricePerMTok: 2,
  completionPricePerMTok: 8,
};

beforeEach(() => resetOpenRouterPricesForTests());

describe('model pricing', () => {
  it('estimates USD from per-million-token prices', () => {
    expect(estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 500_000 }, model)).toBe(6);
    expect(estimateCostUsd({ promptTokens: 10, completionTokens: 10 }, undefined)).toBeUndefined();
    expect(
      estimateCostUsd({ promptTokens: 10, completionTokens: 10 }, { id: 'x', name: 'x' }),
    ).toBeUndefined();
  });

  it('prefers the provider-reported cost and never prices Ollama', () => {
    const prices = new Map([[model.id, model]]);
    const base = { promptTokens: 1_000_000, completionTokens: 0, model: model.id };
    expect(messageCost({ ...base, provider: 'openrouter', costUsd: 0.5 }, prices)).toEqual({
      usd: 0.5,
      estimated: false,
    });
    expect(messageCost({ ...base, provider: 'openrouter' }, prices)).toEqual({
      usd: 2,
      estimated: true,
    });
    expect(messageCost({ ...base, provider: 'openrouter' }, null)).toBeNull();
    expect(messageCost({ ...base, provider: 'ollama' }, prices)).toBeNull();
  });

  it('loads the model list once per session and retries after a failure', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(loadOpenRouterPrices(failing)).rejects.toThrow('offline');
    const load = vi.fn().mockResolvedValue([model]);
    const first = await loadOpenRouterPrices(load);
    const second = await loadOpenRouterPrices(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.get(model.id)).toBe(model);
  });
});

describe('normalizeChatMessage usage / partial', () => {
  it('keeps valid usage and the partial flag on assistant answers', () => {
    const message = normalizeChatMessage({
      id: 'a',
      role: 'assistant',
      content: 'half',
      createdAt: 1,
      partial: true,
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        provider: 'openrouter',
        costUsd: 0.01,
        model: 'm',
      },
    });
    expect(message).toMatchObject({
      partial: true,
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        provider: 'openrouter',
        costUsd: 0.01,
        model: 'm',
      },
    });
  });

  it('drops malformed usage', () => {
    const message = normalizeChatMessage({
      role: 'assistant',
      content: 'x',
      usage: { promptTokens: 'a', completionTokens: 1, provider: 'ollama' },
    });
    expect(message?.usage).toBeUndefined();
    expect(message?.partial).toBeUndefined();
  });
});
