import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useAppStore } from '../store';
import type { JobKind, JobProgress } from '../types';
import JobsHud from './JobsHud';
import { installDomStubs } from '../test/dom';

vi.mock('../store/jobs/enrich', () => ({
  cancelEnrichment: vi.fn(),
  pauseEnrichment: vi.fn(),
  resumeEnrichment: vi.fn(),
  startEnrichment: vi.fn(),
}));
vi.mock('../store/jobs/preview', () => ({
  cancelPreviewCapture: vi.fn(),
  pausePreviewCapture: vi.fn(),
  resumePreviewCapture: vi.fn(),
  startPreviewCapture: vi.fn(),
}));
vi.mock('../store/jobs/health', () => ({ cancelHealthScan: vi.fn() }));

const enrich = await import('../store/jobs/enrich');
const preview = await import('../store/jobs/preview');
const health = await import('../store/jobs/health');

const initial = useAppStore.getState();

const job = (kind: JobKind, overrides: Partial<JobProgress> = {}): JobProgress => ({
  kind,
  state: 'running',
  total: 10,
  done: 4,
  failed: 0,
  startedAt: 0,
  finishedAt: null,
  counters: {},
  ...overrides,
});

const showJob = (progress: JobProgress) => {
  useAppStore.setState({ jobs: { ...initial.jobs, [progress.kind]: progress } });
  render(<JobsHud />);
};

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(initial, true);
});

describe('JobsHud', () => {
  it('stays out of the way while nothing is running', () => {
    render(<JobsHud />);
    expect(screen.queryByRole('region', { name: 'Background tasks' })).toBeNull();
  });

  it('shows how far a running job has got, as text and as a progress bar', () => {
    showJob(job('enrich'));
    expect(screen.getByText('Analysis')).toBeInTheDocument();
    expect(screen.getByText('Running… · 4 of 10')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Analysis' });
    expect(bar).toHaveAttribute('aria-valuenow', '4');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
  });

  it('pauses and cancels the job the card belongs to', () => {
    showJob(job('enrich'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(enrich.pauseEnrichment).toHaveBeenCalledTimes(1);
    expect(enrich.cancelEnrichment).toHaveBeenCalledTimes(1);
    expect(preview.pausePreviewCapture).not.toHaveBeenCalled();
  });

  it('offers resume instead of pause once the job is paused', () => {
    showJob(job('preview', { state: 'paused' }));
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(preview.resumePreviewCapture).toHaveBeenCalledTimes(1);
  });

  it('cannot pause the link check: it has no pause, only cancel', () => {
    showJob(job('health'));
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(health.cancelHealthScan).toHaveBeenCalledTimes(1);
  });

  it('dismisses a finished job instead of cancelling it', () => {
    showJob(job('enrich', { state: 'done', done: 10, finishedAt: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(enrich.cancelEnrichment).not.toHaveBeenCalled();
    expect(useAppStore.getState().jobs.enrich).toBeNull();
  });
});

describe('JobsHud footprint', () => {
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  beforeEach(() => installDomStubs());

  afterEach(() => {
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
  });

  it('reports the space it covers while shown and nothing once it is gone', () => {
    // jsdom has no layout; the HUD's own height stands in for its footprint.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 120,
    });
    const onFootprintChange = vi.fn();
    useAppStore.setState({ jobs: { ...initial.jobs, enrich: job('enrich') } });
    render(<JobsHud onFootprintChange={onFootprintChange} />);
    expect(onFootprintChange).toHaveBeenLastCalledWith(120);

    act(() => useAppStore.setState({ jobs: initial.jobs }));
    expect(onFootprintChange).toHaveBeenLastCalledWith(0);
  });
});
