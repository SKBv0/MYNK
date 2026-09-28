import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import TitleBar from './TitleBar';
import { useAppStore } from '../store';
import { resetApp } from '../test/app';

describe('TitleBar brand', () => {
  beforeEach(() => resetApp());
  afterEach(() => resetApp());

  const header = () => screen.getByRole('banner');

  it('leaves the wordmark to the expanded sidebar and shows only the location', () => {
    render(<TitleBar />);
    expect(header()).not.toHaveTextContent('MYNK');
    expect(header().textContent?.trim()).not.toBe('');
    expect(document.title).toBe('Library · Grid · MYNK');
  });

  it('shows the wordmark while the sidebar is collapsed', () => {
    render(<TitleBar />);
    act(() => useAppStore.getState().toggleSidebar());
    expect(header()).toHaveTextContent('MYNK');
    act(() => useAppStore.getState().toggleSidebar());
    expect(header()).not.toHaveTextContent('MYNK');
  });
});
