import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { installDomStubs } from '../test/dom';
import { makeResource } from '../test/fixtures';
import TimelineView from './TimelineView';
import { formatDate, formatTime } from '../lib/format';

beforeAll(installDomStubs);

describe('TimelineView', () => {
  it('survives a date outside the Date range and exposes list positions', () => {
    const ref = { current: document.createElement('div') };
    render(
      <TimelineView
        resources={[
          makeResource({ title: 'Broken date', createdAt: 1e20 }),
          makeResource({ title: 'Normal', createdAt: Date.now() - 1000 }),
        ]}
        onSelect={vi.fn()}
        scrollContainerRef={ref}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Broken date/ })).toBeInTheDocument();
  });

  it('gives every day group its own list, named by its heading', () => {
    const ref = { current: document.createElement('div') };
    const now = Date.now();
    render(
      <TimelineView
        resources={[
          makeResource({ title: 'First', createdAt: now - 1000 }),
          makeResource({ title: 'Second', createdAt: now - 2000 }),
          makeResource({ title: 'Old', createdAt: now - 60 * 24 * 60 * 60 * 1000 }),
        ]}
        onSelect={vi.fn()}
        scrollContainerRef={ref}
      />,
    );

    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(2);
    const today = screen.getByRole('list', { name: 'Today' });
    const items = within(today).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-posinset'))).toEqual(['1', '2']);
    expect(items.every((item) => item.getAttribute('aria-setsize') === '2')).toBe(true);
    // Lists hold only list items; headings sit outside them.
    for (const list of lists) {
      expect([...list.children].every((child) => child.getAttribute('role') === 'listitem')).toBe(
        true,
      );
    }
  });

  it('shows the day next to the time once a bucket spans several days', () => {
    const ref = { current: document.createElement('div') };
    const recent = Date.now() - 1000;
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const { container } = render(
      <TimelineView
        resources={[
          makeResource({ title: 'Recent', createdAt: recent }),
          makeResource({ title: 'Old', createdAt: old }),
        ]}
        onSelect={vi.fn()}
        scrollContainerRef={ref}
      />,
    );

    const times = [...container.querySelectorAll('time')].map((node) => node.textContent);
    expect(times[0]).toBe(formatTime(recent));
    expect(times[1]).toBe(
      formatDate(old, undefined, { day: 'numeric', month: 'short' }) + formatTime(old),
    );
  });
});
