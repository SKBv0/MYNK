import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../index';
import { publishJob } from './shared';

const PRISTINE = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
});

describe('publishJob', () => {
  it('ignores a late update from an older run once a newer run has published', () => {
    publishJob('enrich', 1_000, { state: 'running', total: 1, done: 0, failed: 0 });
    publishJob('enrich', 2_000, { state: 'done', total: 1, done: 1, failed: 0 });
    publishJob('enrich', 1_000, { state: 'cancelled', total: 1, done: 0, failed: 0 });

    expect(useAppStore.getState().jobs.enrich).toMatchObject({ state: 'done', startedAt: 2_000 });
  });

  it('still updates the run that is showing', () => {
    publishJob('enrich', 1_000, { state: 'running', total: 2, done: 0, failed: 0 });
    publishJob('enrich', 1_000, { state: 'done', total: 2, done: 2, failed: 0 });

    expect(useAppStore.getState().jobs.enrich).toMatchObject({ state: 'done', done: 2 });
  });
});
