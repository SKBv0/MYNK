import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { AgentBridgeInfo, InboxEntry } from '../services/ipcTypes';
import { DEFAULT_AGENT_BRIDGE, ipcReject, mockRust, stopRust, type RustMock } from '../test/ipc';
import { hasToast, renderApp, resetApp, store, waitForToast } from '../test/app';

const MCP_PATH = 'C:\\Program Files\\MYNK\\mynk-mcp.exe';

let rust: RustMock;
let bridge: AgentBridgeInfo;

const openAgents = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const tabs = await screen.findByRole('tablist', { name: 'Settings' });
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Agents' }));
  return screen.findByRole('tabpanel');
};

const entry = (url: string, title: string): InboxEntry => ({
  url,
  title,
  tags: [],
  source: 'mcp:claude-code',
  createdAt: 1_757_000_000_000,
});

beforeEach(() => {
  resetApp();
  bridge = { ...DEFAULT_AGENT_BRIDGE, mcpPath: MCP_PATH, inboxPending: 2 };
  rust = mockRust({ get_agent_bridge_info: () => bridge });
});

afterEach(() => {
  stopRust();
  vi.restoreAllMocks();
});

describe('Settings › Agents', () => {
  it('shows where the program is and what is waiting', async () => {
    await renderApp();
    const panel = await openAgents();

    expect(await within(panel).findByText('The MYNK agent program is installed.')).toBeVisible();
    expect(within(panel).getByText(MCP_PATH)).toBeVisible();
    expect(within(panel).getByText('2 bookmarks are waiting in the inbox.')).toBeVisible();
  });

  it('tells the user when the program is missing instead of showing a path that is not there', async () => {
    bridge = { mcpPath: null, mcpAvailable: false, inboxPending: 0 };
    await renderApp();
    const panel = await openAgents();

    expect(await within(panel).findByText('The MYNK agent program was not found.')).toBeVisible();
    expect(within(panel).queryByText(MCP_PATH)).not.toBeInTheDocument();
    expect(within(panel).getByText('Nothing is waiting in the inbox.')).toBeVisible();
    // A snippet here would configure the assistant to run a program that is not there.
    expect(within(panel).queryByLabelText('Configuration to copy')).not.toBeInTheDocument();
  });

  it('gives every assistant its own snippet, with the path escaped', async () => {
    await renderApp();
    const panel = await openAgents();
    const snippet = () => within(panel).getByLabelText('Configuration to copy');

    expect(await within(panel).findByRole('radio', { name: 'Claude Code' })).toBeChecked();
    expect(snippet()).toHaveTextContent(`claude mcp add mynk -- "${MCP_PATH}"`);

    fireEvent.click(within(panel).getByRole('radio', { name: 'Codex' }));
    expect(snippet().textContent).toBe(
      "[mcp_servers.mynk]\ncommand = 'C:\\Program Files\\MYNK\\mynk-mcp.exe'",
    );

    fireEvent.click(within(panel).getByRole('radio', { name: 'Cursor' }));
    const json: unknown = JSON.parse(snippet().textContent ?? '');
    expect(json).toEqual({ mcpServers: { mynk: { command: MCP_PATH } } });

    fireEvent.click(within(panel).getByRole('radio', { name: 'Other' }));
    expect(snippet().textContent).toContain('"mcpServers"');
  });

  it('copies the location and the snippet', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderApp();
    const panel = await openAgents();

    fireEvent.click(await within(panel).findByRole('button', { name: 'Copy the location' }));
    await waitForToast('Copied.');
    expect(writeText).toHaveBeenCalledWith(MCP_PATH);

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy the configuration' }));
    expect(writeText).toHaveBeenLastCalledWith(`claude mcp add mynk -- "${MCP_PATH}"`);
  });

  it('imports what the inbox holds when the user checks it', async () => {
    rust.on('peek_agent_inbox', () => [
      { name: '1757000000000-aabbccdd.json', entry: entry('https://tokio.rs/', 'Tokio') },
    ]);
    rust.on('ack_agent_inbox', () => {
      bridge = { ...bridge, inboxPending: 0 };
      return null;
    });
    await renderApp();
    const panel = await openAgents();

    fireEvent.click(await within(panel).findByRole('button', { name: 'Check the inbox now' }));

    await waitForToast('1 bookmark added by your agents.');
    expect(store().resources.map((r) => r.url)).toEqual(['https://tokio.rs/']);
    expect(rust.argsOf('ack_agent_inbox')[0]?.names).toEqual(['1757000000000-aabbccdd.json']);
    expect(await within(panel).findByText('Nothing is waiting in the inbox.')).toBeVisible();
  });

  it('says so when the inbox turns out to be empty', async () => {
    await renderApp();
    const panel = await openAgents();

    fireEvent.click(await within(panel).findByRole('button', { name: 'Check the inbox now' }));

    await waitForToast('Nothing new from your agents.');
    expect(rust.countOf('peek_agent_inbox')).toBeGreaterThan(0);
    expect(rust.countOf('ack_agent_inbox')).toBe(0);
  });

  it('explains the blocked library instead of claiming there was nothing new', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();
    const panel = await openAgents();

    fireEvent.click(await within(panel).findByRole('button', { name: 'Check the inbox now' }));

    await waitForToast('cannot be saved right now');
    expect(hasToast('Nothing new from your agents.')).toBe(false);
    expect(rust.countOf('peek_agent_inbox')).toBe(0);
  });
});
