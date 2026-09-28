/** Settings › Advanced updates. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mockRust, stopRust, TEST_APP_VERSION, type RustMock } from '../test/ipc';
import { announceUpdate } from '../store/jobs/update';
import { hasToast, renderApp, resetApp } from '../test/app';

let rust: RustMock;

const openAdvanced = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const tabs = await screen.findByRole('tablist', { name: 'Settings' });
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Advanced' }));
  return screen.findByRole('tabpanel');
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
  vi.restoreAllMocks();
});

describe('Settings › Advanced › updates', () => {
  it('shows the installed version', async () => {
    await renderApp();
    const panel = await openAdvanced();

    expect(await within(panel).findByText(TEST_APP_VERSION)).toBeVisible();
  });

  it('says so when there is nothing newer', async () => {
    await renderApp();
    const panel = await openAdvanced();

    fireEvent.click(within(panel).getByRole('button', { name: 'Check for updates' }));

    expect(await within(panel).findByText('MYNK is up to date.')).toBeVisible();
    expect(rust.countOf('plugin:updater|check')).toBe(1);
  });

  it('offers the install when the server has a newer version, and downloads nothing before', async () => {
    rust.on('plugin:updater|check', () => ({
      rid: 1,
      currentVersion: TEST_APP_VERSION,
      version: '0.2.0',
      rawJson: {},
    }));
    await renderApp();
    const panel = await openAdvanced();

    fireEvent.click(within(panel).getByRole('button', { name: 'Check for updates' }));

    expect(await within(panel).findByText('MYNK 0.2.0 is available.')).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Install' })).toBeVisible();
    expect(rust.countOf('plugin:updater|download_and_install')).toBe(0);
  });

  it('takes back an install offer whose handle the manual check replaces', async () => {
    await renderApp();
    act(() => announceUpdate('0.2.0'));
    expect(hasToast('MYNK 0.2.0 is ready to install.')).toBe(true);
    const panel = await openAdvanced();

    fireEvent.click(within(panel).getByRole('button', { name: 'Check for updates' }));

    await waitFor(() => expect(hasToast('MYNK 0.2.0 is ready to install.')).toBe(false));
  });

  it('treats a release server with nothing for this platform as an answer, not a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rust.on('plugin:updater|check', () => {
      throw 'Could not fetch a valid release JSON: 404 Not Found';
    });
    await renderApp();
    const panel = await openAdvanced();

    fireEvent.click(within(panel).getByRole('button', { name: 'Check for updates' }));

    expect(await within(panel).findByText('No newer version is available.')).toBeVisible();
    expect(within(panel).queryByText(/The update check failed/)).toBeNull();
  });

  it('shows a translated reason when the check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The plugin rejects with its own Rust message, not with MYNK's `{ kind, message }` payload.
    rust.on('plugin:updater|check', () => {
      throw 'Signature mismatch';
    });
    await renderApp();
    const panel = await openAdvanced();

    fireEvent.click(within(panel).getByRole('button', { name: 'Check for updates' }));

    expect(
      await within(panel).findByText(/could not be verified as coming from MYNK/),
    ).toBeVisible();
  });
});
