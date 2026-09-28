/**
 * Agent access: the renderer's side of the bridge with the separate `mynk-mcp` program. Agents
 * never touch `library.json` directly; they drop validated entries into the inbox directory,
 * imported through the normal import path (`store/jobs/inbox.ts`).
 */
import { call } from './ipc';
import type { AgentBridgeInfo, InboxFile } from './ipcTypes';

/** Every pending inbox entry with its file; removes nothing until {@link ackAgentInbox} runs. */
export const peekAgentInbox = (): Promise<InboxFile[]> => call<InboxFile[]>('peek_agent_inbox');

/** Removes the named entry files; call only once the entries are safely on disk. */
export const ackAgentInbox = (names: string[]): Promise<void> =>
  call<void>('ack_agent_inbox', { names });

/** Where the MCP program is, whether it is installed and what the inbox holds. */
export const getAgentBridgeInfo = (): Promise<AgentBridgeInfo> =>
  call<AgentBridgeInfo>('get_agent_bridge_info');
