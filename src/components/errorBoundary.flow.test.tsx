import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';
import * as persistence from '../store/persistence';
import { resetApp, store } from '../test/app';
import { makeResource } from '../test/fixtures';

const Boom: React.FC<{ explode: boolean }> = ({ explode }) => {
  if (explode) throw new Error('render exploded');
  return <p>Everything is fine</p>;
};

/** Lets the test decide, from the outside, whether the child still throws. */
const Harness: React.FC<{ initial: boolean }> = ({ initial }) => {
  const [explode, setExplode] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setExplode(false)}>
        repair
      </button>
      <ErrorBoundary>
        <Boom explode={explode} />
      </ErrorBoundary>
    </>
  );
};

beforeEach(() => {
  resetApp();
  // React logs the caught error; the test asserts on the recovery UI instead.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error boundary', () => {
  it('replaces the crashed subtree with a recovery screen', () => {
    render(<Harness initial />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(screen.getByText('A part of the interface crashed. Your data is safe.')).toBeVisible();
    expect(screen.getByText('render exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('recovers when the cause is gone and the user retries', () => {
    render(<Harness initial />);

    fireEvent.click(screen.getByText('repair'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Everything is fine')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the library data untouched and speaks the UI language', () => {
    store().addResource({ url: 'https://kept.example.com/' });
    store().setLang('tr');
    render(<Harness initial />);

    expect(screen.getByRole('heading', { name: 'Bir şeyler ters gitti' })).toBeInTheDocument();
    expect(store().resources).toHaveLength(1);
  });

  it('a crash in one bookmark card does not blank the rest of the page', () => {
    const resource = makeResource({ title: 'Fine' });
    render(
      <div>
        <p>{resource.title}</p>
        <ErrorBoundary>
          <Boom explode />
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByText('Fine')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('reload flushes the pending library write first', async () => {
    // A never-settling flush keeps jsdom's unimplemented reload out of the test.
    const flush = vi
      .spyOn(persistence, 'flushPersistence')
      .mockImplementation(() => new Promise<persistence.FlushResult>(() => undefined));
    render(<Harness initial />);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
  });
});
