import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  PlugZap,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { AIProvider, AISettings, AISettingsUpdate, ModelInfo } from '../../services/ipcTypes';
import {
  clearOpenRouterApiKey,
  getAiSettings,
  listOllamaModels,
  listOpenRouterModels,
  setOpenRouterApiKey,
  testProviderConnection,
  updateAiSettings,
} from '../../services/aiService';
import { errorKind, reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import { formatBytes, formatTokenCount, formatUsd } from '../../lib/format';
import { useTranslation } from '../../hooks/useTranslation';
import { useLatest } from '../../hooks/useLatest';
import { useAppStore } from '../../store';
import { startEnrichmentConfirmed } from '../../store/jobs/enrich';
import type { AiSetupNotice } from '../../types';
import type { TranslationSchema } from '../../translations';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  IconButton,
  Input,
  SectionTitle,
  SegmentedControl,
  Select,
  Skeleton,
  TONE_PANEL,
  cx,
} from '../ui';

const PROVIDERS: { value: AIProvider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openrouter', label: 'OpenRouter' },
];

const toDraft = (settings: AISettings): AISettingsUpdate => ({
  provider: settings.provider,
  ollamaBaseUrl: settings.ollamaBaseUrl,
  ollamaModel: settings.ollamaModel,
  openrouterModel: settings.openrouterModel,
  allowPrivateNetwork: settings.allowPrivateNetwork,
  embeddingModel: settings.embeddingModel,
});

/** Translated templates for the model details line, passed in because the helper is not a component. */
interface DetailCopy {
  contextLength: string;
  pricePerMTok: string;
}

/**
 * Grey details next to a model name: size and context window (Ollama) or price per million tokens
 * (OpenRouter), e.g. "4.7 GB · 32K context window"; `null` when none is known.
 */
const modelDetails = (model: ModelInfo | undefined, copy: DetailCopy): string | null => {
  if (!model) return null;
  const parts: string[] = [];
  if (model.sizeBytes !== undefined) parts.push(formatBytes(model.sizeBytes));
  if (model.contextLength !== undefined) {
    parts.push(fmt(copy.contextLength, { tokens: formatTokenCount(model.contextLength) }));
  }
  const { promptPricePerMTok, completionPricePerMTok } = model;
  if (promptPricePerMTok !== undefined || completionPricePerMTok !== undefined) {
    parts.push(
      fmt(copy.pricePerMTok, {
        prompt: formatUsd(promptPricePerMTok ?? 0),
        completion: formatUsd(completionPricePerMTok ?? 0),
      }),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
};

/** Plain sentence for the notice; a missing OpenRouter key is named instead of the generic text. */
const setupReasonText = (
  notice: AiSetupNotice,
  t: TranslationSchema,
  draft: AISettingsUpdate | null,
  hasKey: boolean,
): string => {
  const reasons = t.settings.ai.setup.reasons;
  if (notice.reason === 'notConfigured' && draft?.provider === 'openrouter' && !hasKey) {
    return reasons.missingKey;
  }
  return fmt(reasons[notice.reason], {
    model: notice.model ?? '',
    address: draft?.ollamaBaseUrl ?? '',
  });
};

/** Explains why the app opened this tab and links back to the library. */
const SetupNotice: React.FC<{
  notice: AiSetupNotice;
  draft: AISettingsUpdate | null;
  hasKey: boolean;
  /** The form holds unsaved edits, so continuing has to save them first. */
  dirty: boolean;
  busy: boolean;
  onContinue: () => void;
}> = ({ notice, draft, hasKey, dirty, busy, onContinue }) => {
  const { t } = useTranslation();
  const dismiss = useAppStore((s) => s.dismissAiSetupNotice);
  const cardRef = useRef<HTMLDivElement>(null);

  // The app opened this tab itself, so focus moves to the explanation.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <Card
      ref={cardRef}
      tabIndex={-1}
      data-focus-container=""
      role="status"
      padding="lg"
      className="flex items-start gap-3"
    >
      <Sparkles size={20} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="text-md font-semibold text-fg">{t.settings.ai.setup.title}</h2>
        <p className="text-base text-fg-secondary">{setupReasonText(notice, t, draft, hasKey)}</p>
        <p className="text-base text-fg-muted">{t.settings.ai.setup.hint}</p>
        <Button variant="soft" icon={Sparkles} loading={busy} onClick={onContinue}>
          {dirty ? t.settings.ai.setup.saveAndContinue : t.settings.ai.setup.continue}
        </Button>
      </div>
      <IconButton label={t.settings.ai.setup.dismiss} icon={X} onClick={dismiss} />
    </Card>
  );
};

const AiSettingsTab: React.FC = () => {
  const { t } = useTranslation();
  const pushToast = useAppStore((s) => s.pushToast);
  const [status, setStatus] = useState<'loading' | 'ready' | 'desktopOnly' | 'error'>('loading');
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [draft, setDraft] = useState<AISettingsUpdate | null>(null);
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<ModelInfo[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  // Model discovery and a save/test run independent spinners.
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'key'>(null);
  const [discovering, setDiscovering] = useState(false);
  /** Why the Ollama list is empty, so an empty `<Select>` is never left unexplained. */
  const [ollamaReach, setOllamaReach] = useState<'unknown' | 'ok' | 'empty' | 'unreachable'>(
    'unknown',
  );
  const modelRequest = useRef(0);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const setupNotice = useAppStore((s) => s.aiSetupNotice);
  const goToPage = useAppStore((s) => s.goToPage);
  const modelDetailsId = useId();

  // Read via a ref so the bootstrap fetch stays a true mount effect across language switches.
  const latest = useLatest({ t });

  useEffect(() => {
    let cancelled = false;
    getAiSettings()
      .then((current) => {
        if (cancelled) return;
        setSettings(current);
        setDraft(toDraft(current));
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (errorKind(error) === 'desktopOnly') {
          setStatus('desktopOnly');
          return;
        }
        setStatus('error');
        reportError(error, 'settings.ai.load', { prefix: latest.current.t.settings.ai.loadFailed });
      });
    return () => {
      cancelled = true;
    };
  }, [latest]);

  const refreshOllamaModels = useCallback(
    async (baseUrl: string, allowPrivateNetwork: boolean, announce: boolean) => {
      const request = ++modelRequest.current;
      setDiscovering(true);
      try {
        const models = await listOllamaModels(baseUrl, allowPrivateNetwork);
        if (request !== modelRequest.current) return;
        setOllamaModels(models);
        setOllamaReach(models.length > 0 ? 'ok' : 'empty');
        // Embedding models cannot chat, so one is never picked automatically.
        const firstChatModel = models.find((model) => model.embedding !== true);
        setDraft((prev) =>
          prev && prev.provider === 'ollama' && !prev.ollamaModel.trim() && firstChatModel
            ? { ...prev, ollamaModel: firstChatModel.id }
            : prev,
        );
        if (announce) {
          const copy = latest.current.t;
          pushToast(
            models.length > 0
              ? fmt(copy.settings.ai.modelsLoaded, { count: models.length })
              : copy.settings.ai.noModels,
            models.length > 0 ? 'success' : 'info',
          );
        }
      } catch (error) {
        if (request !== modelRequest.current) return;
        setOllamaModels([]);
        setOllamaReach('unreachable');
        if (announce) {
          reportError(error, 'settings.ai.models', {
            prefix: latest.current.t.settings.ai.modelsFailed,
          });
        }
      } finally {
        if (request === modelRequest.current) setDiscovering(false);
      }
    },
    [latest, pushToast],
  );

  // Debounced model discovery while the endpoint is being typed; stale responses are ignored.
  const provider = draft?.provider;
  const baseUrl = draft?.ollamaBaseUrl;
  const allowPrivateNetwork = draft?.allowPrivateNetwork ?? false;
  useEffect(() => {
    if (status !== 'ready' || provider !== 'ollama' || baseUrl === undefined) return;
    const handle = window.setTimeout(
      () => void refreshOllamaModels(baseUrl, allowPrivateNetwork, false),
      450,
    );
    return () => window.clearTimeout(handle);
  }, [status, provider, baseUrl, allowPrivateNetwork, refreshOllamaModels]);

  const refreshOpenRouterModels = async () => {
    const request = ++modelRequest.current;
    setDiscovering(true);
    try {
      const models = await listOpenRouterModels();
      if (request !== modelRequest.current) return;
      setOpenRouterModels(models);
      pushToast(fmt(t.settings.ai.modelsLoaded, { count: models.length }), 'success');
    } catch (error) {
      if (request === modelRequest.current) {
        reportError(error, 'settings.ai.models', { prefix: t.settings.ai.modelsFailed });
      }
    } finally {
      if (request === modelRequest.current) setDiscovering(false);
    }
  };

  const run = async (kind: 'save' | 'test' | 'key', action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      reportError(error, `settings.ai.${kind}`);
    } finally {
      setBusy(null);
    }
  };

  /** The form differs from what is stored, so "continue" has to save before it runs. */
  const dirty =
    draft !== null &&
    settings !== null &&
    JSON.stringify(draft) !== JSON.stringify(toDraft(settings));

  const saveDraft = async (): Promise<boolean> => {
    if (!draft) return false;
    setBusy('save');
    try {
      const updated = await updateAiSettings(draft);
      setSettings(updated);
      setDraft(toDraft(updated));
      return true;
    } catch (error) {
      reportError(error, 'settings.ai.save');
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** The selected Ollama model is an embedding model: analysis and chat would fail with it. */
  const embeddingSelected =
    draft?.provider === 'ollama' &&
    ollamaModels.some((model) => model.id === draft.ollamaModel && model.embedding === true);

  // Continuing with an unsaved draft or an embedding model would fail and loop back here.
  const continueAnalysis = (targets: string[] | 'all') => {
    if (embeddingSelected) {
      pushToast(t.settings.ai.embeddingSelected, 'error');
      return;
    }
    void (async () => {
      if (dirty && !(await saveDraft())) return;
      goToPage('library');
      void startEnrichmentConfirmed(targets === 'all' ? undefined : targets);
    })();
  };

  const notice = setupNotice && (
    <SetupNotice
      notice={setupNotice}
      draft={draft}
      hasKey={settings?.hasOpenrouterApiKey ?? false}
      dirty={dirty}
      busy={busy === 'save'}
      onContinue={() => continueAnalysis(setupNotice.targets)}
    />
  );

  if (status === 'loading') {
    return (
      <div className="space-y-4">
        {notice}
        <Card padding="lg" className="space-y-4" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-control-md w-full" />
          <Skeleton className="h-control-md w-2/3" />
        </Card>
      </div>
    );
  }

  if (status !== 'ready' || !draft) {
    return (
      <div className="space-y-4">
        {notice}
        <Card padding="lg" className="flex items-start gap-3">
          <ShieldAlert size={20} aria-hidden className="shrink-0 text-accent-text" />
          <p className="text-base text-fg-secondary">
            {status === 'desktopOnly' ? t.settings.ai.desktopOnly : t.settings.ai.unavailable}
          </p>
        </Card>
      </div>
    );
  }

  const update = (patch: Partial<AISettingsUpdate>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  /** The server listed its models and the chosen one is not among them; the choice stays the user's. */
  const modelMissing =
    draft.provider === 'ollama' &&
    ollamaModels.length > 0 &&
    draft.ollamaModel !== '' &&
    !ollamaModels.some((model) => model.id === draft.ollamaModel);

  const detailCopy: DetailCopy = {
    contextLength: t.settings.ai.contextLength,
    pricePerMTok: t.settings.ai.pricePerMTok,
  };
  const selectedDetails =
    draft.provider === 'ollama'
      ? modelDetails(
          ollamaModels.find((model) => model.id === draft.ollamaModel),
          detailCopy,
        )
      : modelDetails(
          openRouterModels.find((model) => model.id === draft.openrouterModel),
          detailCopy,
        );

  return (
    <div className="space-y-4">
      {notice}
      <Card padding="lg" className="space-y-6">
        <SectionTitle
          description={t.settings.ai.providerHint}
          actions={
            <SegmentedControl
              label={t.settings.ai.providerTitle}
              value={draft.provider}
              onChange={(value) => update({ provider: value })}
              options={PROVIDERS}
            />
          }
        >
          {t.settings.ai.providerTitle}
        </SectionTitle>

        {draft.provider === 'ollama' && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label={t.settings.ai.endpoint}
              value={draft.ollamaBaseUrl}
              onChange={(event) => update({ ollamaBaseUrl: event.target.value })}
              placeholder="http://127.0.0.1:11434"
              spellCheck={false}
            />
            <div>
              <div className="flex items-end gap-2">
                <Select
                  label={t.settings.ai.model}
                  value={draft.ollamaModel}
                  onChange={(event) => update({ ollamaModel: event.target.value })}
                  containerClassName="flex-1"
                  aria-describedby={selectedDetails ? modelDetailsId : undefined}
                  error={
                    embeddingSelected
                      ? t.settings.ai.embeddingSelected
                      : modelMissing
                        ? t.settings.ai.modelMissing
                        : undefined
                  }
                >
                  <option value="">{t.settings.ai.selectModel}</option>
                  {draft.ollamaModel && !ollamaModels.some((m) => m.id === draft.ollamaModel) && (
                    <option value={draft.ollamaModel}>
                      {modelMissing
                        ? fmt(t.settings.ai.modelMissingOption, { name: draft.ollamaModel })
                        : draft.ollamaModel}
                    </option>
                  )}
                  {ollamaModels.map((model) => {
                    const details = modelDetails(model, detailCopy);
                    return (
                      <option key={model.id} value={model.id} disabled={model.embedding === true}>
                        {model.embedding === true
                          ? fmt(t.settings.ai.embeddingOption, { name: model.name })
                          : details
                            ? `${model.name} · ${details}`
                            : model.name}
                      </option>
                    );
                  })}
                </Select>
                <IconButton
                  label={t.settings.ai.refreshModels}
                  icon={RefreshCw}
                  variant="secondary"
                  size="md"
                  // Stays clickable during a silent search; a click still runs an announced one.
                  aria-busy={discovering || undefined}
                  iconClassName={discovering ? 'animate-spin' : undefined}
                  onClick={() =>
                    void refreshOllamaModels(draft.ollamaBaseUrl, draft.allowPrivateNetwork, true)
                  }
                />
              </div>
              {selectedDetails && (
                <p id={modelDetailsId} className="mt-1.5 text-sm text-fg-muted">
                  {selectedDetails}
                </p>
              )}
              {/* Reduced motion freezes the refresh spinner, so the search also says so in words. */}
              {discovering && (
                <p className="mt-1.5 text-sm text-fg-muted">{t.settings.ai.searchingModels}</p>
              )}
              {!discovering && ollamaModels.length === 0 && ollamaReach === 'unreachable' && (
                <div className={cx('mt-2 space-y-2 rounded-md border p-3', TONE_PANEL.warning)}>
                  <p className="text-sm text-fg">
                    {fmt(t.settings.ai.ollamaUnreachable, { address: draft.ollamaBaseUrl })}
                  </p>
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => update({ provider: 'openrouter' })}
                  >
                    {t.settings.ai.switchToOpenRouter}
                  </Button>
                </div>
              )}
              {!discovering && ollamaModels.length === 0 && ollamaReach === 'empty' && (
                <p className="mt-2 rounded-md border border-line bg-surface-2 p-3 text-sm text-fg">
                  {fmt(t.settings.ai.ollamaNoModels, { model: t.settings.ai.suggestedModel })}
                </p>
              )}
            </div>
          </div>
        )}

        {draft.provider === 'openrouter' && (
          <div className="space-y-4">
            <div className="flex items-end gap-2">
              <Input
                label={t.settings.ai.apiKey}
                type="password"
                autoComplete="off"
                icon={KeyRound}
                value={apiKey}
                error={keyError ?? undefined}
                hint={t.settings.ai.apiKeyHint}
                containerClassName="flex-1"
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (keyError) setKeyError(null);
                }}
                placeholder="sk-or-v1-…"
              />
              <Button
                variant="secondary"
                loading={busy === 'key'}
                onClick={() =>
                  void run('key', async () => {
                    if (!apiKey.trim()) {
                      setKeyError(t.settings.ai.keyEmpty);
                      return;
                    }
                    await setOpenRouterApiKey(apiKey.trim());
                    setApiKey('');
                    setSettings(await getAiSettings());
                    pushToast(t.settings.ai.keySaved, 'success');
                  })
                }
              >
                {busy === 'key' ? t.settings.ai.saving : t.settings.ai.saveKey}
              </Button>
              {settings?.hasOpenrouterApiKey && (
                <IconButton
                  label={t.settings.ai.removeKey}
                  icon={Trash2}
                  variant="danger"
                  size="md"
                  loading={busy === 'key'}
                  onClick={() =>
                    requestConfirm({
                      title: t.settings.ai.removeKeyTitle,
                      message: t.settings.ai.removeKeyMessage,
                      confirmLabel: t.settings.ai.removeKey,
                      danger: true,
                      onConfirm: () =>
                        void run('key', async () => {
                          await clearOpenRouterApiKey();
                          setSettings(await getAiSettings());
                          pushToast(t.settings.ai.keyRemoved, 'success');
                        }),
                    })
                  }
                />
              )}
            </div>
            <Badge
              tone={settings?.hasOpenrouterApiKey ? 'success' : 'warning'}
              icon={settings?.hasOpenrouterApiKey ? CheckCircle2 : CircleAlert}
            >
              {settings?.hasOpenrouterApiKey ? t.settings.ai.keyStored : t.settings.ai.keyMissing}
            </Badge>

            <div>
              <div className="flex items-end gap-2">
                <Input
                  label={t.settings.ai.model}
                  list="openrouter-model-list"
                  value={draft.openrouterModel}
                  onChange={(event) => update({ openrouterModel: event.target.value })}
                  className="font-mono"
                  placeholder="openai/gpt-4o-mini"
                  spellCheck={false}
                  containerClassName="flex-1"
                  aria-describedby={selectedDetails ? modelDetailsId : undefined}
                />
                <IconButton
                  label={t.settings.ai.refreshModels}
                  icon={RefreshCw}
                  variant="secondary"
                  size="md"
                  aria-busy={discovering || undefined}
                  iconClassName={discovering ? 'animate-spin' : undefined}
                  onClick={() => void refreshOpenRouterModels()}
                />
                <datalist id="openrouter-model-list">
                  {openRouterModels.map((model) => {
                    const details = modelDetails(model, detailCopy);
                    return (
                      <option key={model.id} value={model.id}>
                        {details ? `${model.name} · ${details}` : model.name}
                      </option>
                    );
                  })}
                </datalist>
              </div>
              {selectedDetails && (
                <p id={modelDetailsId} className="mt-1.5 text-sm text-fg-muted">
                  {selectedDetails}
                </p>
              )}
              {discovering && (
                <p className="mt-1.5 text-sm text-fg-muted">{t.settings.ai.searchingModels}</p>
              )}
            </div>
          </div>
        )}

        {draft.provider === 'ollama' && (
          <Select
            label={t.settings.ai.embeddingModel}
            hint={t.settings.ai.embeddingModelHint}
            value={draft.embeddingModel}
            onChange={(event) => update({ embeddingModel: event.target.value })}
            containerClassName="md:w-1/2 md:pr-2"
          >
            <option value="">{t.settings.ai.embeddingAuto}</option>
            {draft.embeddingModel &&
              !ollamaModels.some((model) => model.id === draft.embeddingModel) && (
                <option value={draft.embeddingModel}>{draft.embeddingModel}</option>
              )}
            {ollamaModels
              .filter((model) => model.embedding === true)
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
          </Select>
        )}

        <Checkbox
          checked={draft.allowPrivateNetwork}
          onChange={(event) => update({ allowPrivateNetwork: event.target.checked })}
          label={t.settings.ai.allowPrivateNetwork}
          description={t.settings.ai.allowPrivateNetworkHint}
        />
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          icon={PlugZap}
          loading={busy === 'test'}
          onClick={() =>
            void run('test', async () => {
              const result = await testProviderConnection(draft);
              const latency =
                result.latencyMs !== undefined
                  ? ` (${fmt(t.settings.ai.latency, { ms: result.latencyMs })})`
                  : '';
              // `result.message` is untranslated backend text; `result.reason` drives the UI copy.
              const providerName =
                PROVIDERS.find((item) => item.value === draft.provider)?.label ?? draft.provider;
              const model = draft.provider === 'ollama' ? draft.ollamaModel : draft.openrouterModel;
              const failure =
                result.reason && result.reason !== 'other'
                  ? fmt(t.settings.ai.testFailedReason, {
                      reason: fmt(t.settings.ai.testReasons[result.reason], { model }),
                    })
                  : t.settings.ai.testFailed;
              pushToast(
                result.ok
                  ? `${fmt(t.settings.ai.testOk, { provider: providerName })}${latency}`
                  : failure,
                result.ok ? 'success' : 'error',
              );
            })
          }
        >
          {t.settings.ai.test}
        </Button>
        <Button
          variant="primary"
          icon={Save}
          loading={busy === 'save'}
          onClick={() => {
            if (embeddingSelected) {
              pushToast(t.settings.ai.embeddingSelected, 'error');
              return;
            }
            void saveDraft().then((ok) => {
              if (ok) pushToast(t.settings.ai.saved, 'success');
            });
          }}
        >
          {t.settings.ai.save}
        </Button>
      </div>
    </div>
  );
};

export default AiSettingsTab;
