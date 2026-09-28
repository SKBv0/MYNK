import React, { useCallback, useEffect, useState } from 'react';
import { Bot, CircleAlert, Copy, Inbox, PlugZap, RefreshCw } from 'lucide-react';
import type { AgentBridgeInfo } from '../../services/ipcTypes';
import { getAgentBridgeInfo } from '../../services/agents';
import { useAppStore } from '../../store';
import { drainInboxNow } from '../../store/jobs/inbox';
import { isLibraryWriteBlocked, isSaveFailing } from '../../store/persistence';
import { copyToClipboard, errorKind, reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import { useTranslation } from '../../hooks/useTranslation';
import { useLatest } from '../../hooks/useLatest';
import { Button, Card, IconButton, SectionTitle, SegmentedControl, Skeleton } from '../ui';

export type AgentClientId = 'claudeCode' | 'codex' | 'cursor' | 'windsurf' | 'other';

const CLIENT_IDS: readonly AgentClientId[] = ['claudeCode', 'codex', 'cursor', 'windsurf', 'other'];

/** TOML literal string for a path; falls back to a JSON-escaped string if it holds a quote. */
const tomlPath = (value: string): string =>
  value.includes("'") ? JSON.stringify(value) : `'${value}'`;

const mcpSnippet = (client: AgentClientId, mcpPath: string): string => {
  switch (client) {
    case 'claudeCode':
      return `claude mcp add mynk -- "${mcpPath}"`;
    case 'codex':
      return `[mcp_servers.mynk]\ncommand = ${tomlPath(mcpPath)}`;
    default:
      return JSON.stringify({ mcpServers: { mynk: { command: mcpPath } } }, null, 2);
  }
};

const Snippet: React.FC<{ text: string; label: string; copyLabel: string; copied: string }> = ({
  text,
  label,
  copyLabel,
  copied,
}) => (
  <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 p-3">
    <pre
      aria-label={label}
      tabIndex={0}
      className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm text-fg-secondary"
    >
      {text}
    </pre>
    {/* The success toast lives in the app's polite live region, so the copy is announced. */}
    <IconButton label={copyLabel} icon={Copy} onClick={() => void copyToClipboard(text, copied)} />
  </div>
);

const StatusCard: React.FC<{
  info: AgentBridgeInfo;
  checking: boolean;
  onCheck: () => void;
}> = ({ info, checking, onCheck }) => {
  const { t } = useTranslation();
  const a = t.settings.agents;
  const StatusIcon = info.mcpAvailable ? PlugZap : CircleAlert;
  return (
    <Card padding="lg" className="space-y-4">
      <SectionTitle description={a.statusHint}>{a.statusTitle}</SectionTitle>

      <p className="flex items-center gap-2 text-base font-medium text-fg">
        <StatusIcon
          size={18}
          aria-hidden
          className={info.mcpAvailable ? 'shrink-0 text-success' : 'shrink-0 text-warning'}
        />
        {info.mcpAvailable ? a.mcpFound : a.mcpMissing}
      </p>

      {info.mcpPath ? (
        <div className="space-y-1">
          <h3 id="agents-path-label" className="text-sm font-semibold text-fg-secondary">
            {a.pathLabel}
          </h3>
          <div className="flex items-center gap-2">
            <code
              aria-labelledby="agents-path-label"
              className="min-w-0 flex-1 truncate rounded-sm bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg-muted"
            >
              {info.mcpPath}
            </code>
            <IconButton
              label={a.copyPath}
              icon={Copy}
              onClick={() => void copyToClipboard(info.mcpPath ?? '', a.copied)}
            />
          </div>
        </div>
      ) : (
        <p className="text-base text-fg-muted">{a.mcpMissingHint}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-4">
        <p className="flex items-center gap-2 text-base text-fg-secondary">
          <Inbox size={16} aria-hidden className="shrink-0 text-accent-text" />
          {info.inboxPending > 0 ? fmt(a.pending, { count: info.inboxPending }) : a.pendingNone}
        </p>
        <Button icon={RefreshCw} loading={checking} onClick={onCheck}>
          {checking ? a.checking : a.checkNow}
        </Button>
      </div>
    </Card>
  );
};

const AgentsTab: React.FC = () => {
  const { t } = useTranslation();
  const pushToast = useAppStore((s) => s.pushToast);
  const a = t.settings.agents;
  const [status, setStatus] = useState<'loading' | 'ready' | 'desktopOnly' | 'error'>('loading');
  const [info, setInfo] = useState<AgentBridgeInfo | null>(null);
  const [client, setClient] = useState<AgentClientId>('claudeCode');
  const [checking, setChecking] = useState(false);

  // Read via a ref so the mount effect below does not re-run on every language switch.
  const latest = useLatest({ t });

  const load = useCallback(async (): Promise<void> => {
    try {
      setInfo(await getAgentBridgeInfo());
      setStatus('ready');
    } catch (error) {
      if (errorKind(error) === 'desktopOnly') {
        setStatus('desktopOnly');
        return;
      }
      setStatus('error');
      reportError(error, 'settings.agents.load', {
        prefix: latest.current.t.settings.agents.loadFailed,
      });
    }
  }, [latest]);

  useEffect(() => {
    void load();
  }, [load]);

  const checkInbox = async () => {
    setChecking(true);
    try {
      const outcome = await drainInboxNow();
      // Additions are already announced by the inbox job itself.
      if (outcome.added === 0) {
        // Import never ran (library write-blocked); do not report "nothing new".
        if (isLibraryWriteBlocked() || isSaveFailing()) pushToast(a.checkBlocked, 'error');
        else
          pushToast(
            outcome.merged > 0 ? fmt(a.checkMerged, { count: outcome.merged }) : a.checkEmpty,
            'info',
          );
      }
    } finally {
      setChecking(false);
      await load();
    }
  };

  if (status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (status === 'desktopOnly') return <p className="text-base text-fg-muted">{a.desktopOnly}</p>;
  if (!info) return <p className="text-base text-fg-muted">{a.loadFailed}</p>;

  return (
    <div className="space-y-4">
      <StatusCard info={info} checking={checking} onCheck={() => void checkInbox()} />

      {/* Without the program the snippet would configure an assistant to run nothing. */}
      {info.mcpPath && (
        <Card padding="lg" className="space-y-4">
          <SectionTitle description={a.clientsHint}>{a.clientsTitle}</SectionTitle>
          <SegmentedControl
            label={a.clientLabel}
            value={client}
            onChange={setClient}
            options={CLIENT_IDS.map((id) => ({ value: id, label: a.clients[id] }))}
          />
          <p className="text-base text-fg-muted">{a.clientHints[client]}</p>
          <Snippet
            text={mcpSnippet(client, info.mcpPath)}
            label={a.snippetLabel}
            copyLabel={a.copySnippet}
            copied={a.copied}
          />
        </Card>
      )}

      <Card padding="lg" className="space-y-3">
        <SectionTitle>{a.aboutTitle}</SectionTitle>
        <ul className="space-y-2">
          {[a.aboutSearch, a.aboutRecent, a.aboutAdd].map((line) => (
            <li key={line} className="flex items-start gap-2 text-base text-fg-secondary">
              <Bot size={16} aria-hidden className="mt-1 shrink-0 text-accent-text" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-line-subtle pt-3 text-base text-fg-muted">{a.aboutOffline}</p>
      </Card>
    </div>
  );
};

export default AgentsTab;
