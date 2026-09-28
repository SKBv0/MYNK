import React, { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import { Folder, FolderPlus, Pencil, Pin, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { Collection, Resource } from '../types';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { suggestKeywords } from '../services/aiService';
import SmartImage from './SmartImage';
import { collectionMembers } from '../store/selectors';
import { MAX_COLLECTION_KEYWORDS } from '../store/model';
import { resourcePreviews } from '../lib/media';
import { reportError } from '../lib/errors';
import { fmt, normalizeTags } from '../lib/text';
import {
  Badge,
  Button,
  Card,
  CardAction,
  EmptyState,
  INSET_SURFACE,
  IconButton,
  Input,
  Modal,
  PageHeader,
  cx,
} from './ui';
import { FieldChrome } from './ui/Field';
import { describedBy } from './ui/fieldIds';
import { FIELD_BORDER, FIELD_BORDER_INVALID, FIELD_SURFACE, REVEAL_ON_HOVER } from './ui/styles';
import { useReportFlag } from '../hooks/useReportFlag';

const PREVIEW_LIMIT = 12;
const keywordList = (list: string[]) => normalizeTags(list, MAX_COLLECTION_KEYWORDS);

interface FormErrors {
  name?: string | undefined;
  keywords?: string | undefined;
}

const CollectionForm: React.FC<{
  editing: Collection | null;
  resources: Resource[];
  onClose: () => void;
  /** Reports whether the form holds unsaved input, for the dialog's close guard. */
  onDirtyChange: (dirty: boolean) => void;
}> = ({ editing, resources, onClose, onDirtyChange }) => {
  const { t, lang } = useTranslation();
  const createCollection = useAppStore((s) => s.createCollection);
  const updateCollection = useAppStore((s) => s.updateCollection);
  const pushToast = useAppStore((s) => s.pushToast);
  const mediaReady = useAppStore((s) => s.mediaReady);
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [keywordInput, setKeywordInput] = useState('');
  const [keywords, setKeywords] = useState<string[]>(editing?.keywords ?? []);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const keywordId = useId();

  const isDirty =
    name !== (editing?.name ?? '') ||
    description !== (editing?.description ?? '') ||
    keywordInput.trim() !== '' ||
    keywords.join('\n') !== (editing?.keywords ?? []).join('\n');
  useReportFlag(onDirtyChange, isDirty);

  const deferredKeywords = useDeferredValue(keywords);
  const matches = useMemo(() => {
    if (deferredKeywords.length === 0) return [];
    return collectionMembers(
      {
        id: '__preview__',
        name: '',
        description: '',
        keywords: deferredKeywords,
        pinnedIds: editing?.pinnedIds ?? [],
        createdAt: 0,
        updatedAt: 0,
      },
      resources,
    );
  }, [deferredKeywords, editing, resources]);

  const pushKeyword = (raw: string) => {
    setKeywords((prev) => keywordList([...prev, ...raw.split(',')]));
    setErrors((prev) => ({ ...prev, keywords: undefined }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      pushKeyword(keywordInput);
      setKeywordInput('');
    } else if (e.key === 'Backspace' && !keywordInput && keywords.length > 0) {
      setKeywords((prev) => prev.slice(0, -1));
    }
  };

  const handleSuggest = async () => {
    if (!name.trim()) {
      setErrors((prev) => ({ ...prev, name: t.collections.nameFirst }));
      return;
    }
    setIsSuggesting(true);
    try {
      const suggestions = await suggestKeywords(name, description, lang);
      const unique = suggestions.filter((s) => !keywords.includes(s));
      if (unique.length > 0) setKeywords((prev) => keywordList([...prev, ...unique]));
      pushToast(fmt(t.collections.suggested, { count: unique.length }), 'success');
    } catch (error) {
      reportError(error, 'collections.suggest', { prefix: t.collections.suggestFailed });
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalKeywords = keywordInput.trim()
      ? keywordList([...keywords, ...keywordInput.split(',')])
      : keywords;
    const nextErrors: FormErrors = {
      name: name.trim() ? undefined : t.collections.nameRequired,
      keywords: finalKeywords.length > 0 ? undefined : t.collections.keywordsRequired,
    };
    if (nextErrors.name || nextErrors.keywords) {
      setErrors(nextErrors);
      return;
    }
    if (editing) {
      updateCollection(editing.id, { name, description, keywords: finalKeywords });
      pushToast(t.collections.updated, 'success');
    } else {
      createCollection({ name, description, keywords: finalKeywords });
      pushToast(t.collections.created, 'success');
    }
    onClose();
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Input
          data-autofocus
          label={t.collections.name}
          placeholder={t.collections.namePlaceholder}
          value={name}
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
          }}
        />
        <Input
          label={t.collections.description}
          placeholder={t.collections.descriptionPlaceholder}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <FieldChrome id={keywordId} hint={t.collections.keywordHelp} error={errors.keywords}>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor={keywordId} className="text-sm font-medium text-fg-secondary">
            {t.collections.keywords}
          </label>
          <Button
            size="sm"
            variant="ghost"
            icon={Sparkles}
            loading={isSuggesting}
            onClick={() => void handleSuggest()}
          >
            {t.collections.suggest}
          </Button>
        </div>
        <div
          className={cx(
            'flex min-h-control-lg flex-wrap items-center gap-1.5 px-2 py-1.5',
            FIELD_SURFACE,
            errors.keywords ? FIELD_BORDER_INVALID : FIELD_BORDER,
          )}
        >
          {keywords.map((kw) => (
            <span
              key={kw}
              className="inline-flex h-7 items-center gap-1 rounded-sm bg-accent-soft pl-2 text-sm font-medium text-accent-text"
            >
              #{kw}
              <IconButton
                label={fmt(t.collections.removeKeyword, { keyword: kw })}
                icon={X}
                size="xs"
                tooltip={false}
                className="text-accent-text hover:bg-accent/20 hover:text-accent-text"
                onClick={() => setKeywords((prev) => prev.filter((k) => k !== kw))}
              />
            </span>
          ))}
          <input
            id={keywordId}
            type="text"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.collections.typeAndEnter}
            aria-invalid={errors.keywords ? true : undefined}
            aria-describedby={describedBy(keywordId, t.collections.keywordHelp, errors.keywords)}
            className="field-control h-7 min-w-40 flex-1 bg-transparent px-1 text-base text-fg placeholder:text-fg-muted"
          />
        </div>
      </FieldChrome>

      <section aria-labelledby={`${keywordId}-preview`} className={cx(INSET_SURFACE, 'p-4')}>
        <div className="mb-3 flex items-center justify-between">
          <h3 id={`${keywordId}-preview`} className="text-overline">
            {t.collections.livePreview}
          </h3>
          {/* Always mounted, so the live region announces changes rather than its own arrival. */}
          <span className="text-sm font-medium tabular-nums text-accent-text" aria-live="polite">
            {keywords.length > 0 ? fmt(t.collections.matches, { count: matches.length }) : ''}
          </span>
        </div>
        {keywords.length === 0 || matches.length === 0 ? (
          <p className="flex items-center gap-2 py-4 text-base text-fg-muted">
            <Search size={16} aria-hidden />
            {keywords.length === 0 ? t.collections.previewEmpty : t.collections.previewNoMatch}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {matches.slice(0, PREVIEW_LIMIT).map((r) => (
              <li
                key={r.id}
                className="overflow-hidden rounded-sm border border-line-subtle bg-surface-1"
              >
                <SmartImage
                  sources={resourcePreviews(r, mediaReady)}
                  alt=""
                  className="aspect-video w-full object-cover"
                  loading="lazy"
                />
                <p className="truncate px-1.5 py-1 text-xs text-fg-secondary">{r.title}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t.common.cancel}</Button>
        <Button type="submit" variant="primary" icon={editing ? undefined : Plus}>
          {editing ? t.collections.save : t.collections.create}
        </Button>
      </div>
    </form>
  );
};

const CollectionCard: React.FC<{
  collection: Collection;
  members: Resource[];
  onEdit: () => void;
  onDelete: () => void;
}> = ({ collection, members, onEdit, onDelete }) => {
  const { t } = useTranslation();
  const openCollection = useAppStore((s) => s.openCollection);
  const mediaReady = useAppStore((s) => s.mediaReady);
  const thumbs = members.slice(0, 4);

  return (
    <Card as="article" variant="interactive" className="group flex h-full flex-col overflow-hidden">
      <div
        className={cx(
          'grid h-28 shrink-0 gap-px bg-surface-3',
          thumbs.length <= 1 ? 'grid-cols-1' : 'grid-cols-2',
          thumbs.length > 2 && 'grid-rows-2',
        )}
      >
        {thumbs.length > 0 ? (
          thumbs.map((r) => (
            <SmartImage
              key={r.id}
              sources={resourcePreviews(r, mediaReady)}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ))
        ) : (
          <div className="flex items-center justify-center text-fg-muted">
            <Folder size={28} aria-hidden />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="truncate text-md font-semibold text-fg">
          <CardAction
            onClick={() => openCollection(collection.id)}
            aria-label={fmt(t.collections.open, { name: collection.name })}
            className="group-hover:text-accent-text"
          >
            {collection.name}
          </CardAction>
        </h3>
        {collection.description && (
          <p className="line-clamp-2 text-sm text-fg-muted">{collection.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="accent">{fmt(t.collections.items, { count: members.length })}</Badge>
          {collection.pinnedIds.length > 0 && (
            <Badge icon={Pin}>
              {fmt(t.collections.pinned, { count: collection.pinnedIds.length })}
            </Badge>
          )}
        </div>
        <p className="mt-auto truncate pt-1 text-sm text-fg-muted">
          {collection.keywords.map((kw) => `#${kw}`).join('  ')}
        </p>
      </div>
      <div className={cx('absolute right-2 top-2 z-10 flex gap-1', REVEAL_ON_HOVER)}>
        <IconButton label={t.collections.edit} icon={Pencil} variant="overlay" onClick={onEdit} />
        <IconButton
          label={t.collections.delete}
          icon={Trash2}
          variant="overlay"
          onClick={onDelete}
        />
      </div>
    </Card>
  );
};

/** Smart folders: a bookmark belongs to one by keyword match or by being pinned. */
const CollectionsView: React.FC = () => {
  const { t } = useTranslation();
  const collections = useAppStore((s) => s.collections);
  const resources = useAppStore((s) => s.resources);
  const deleteCollection = useAppStore((s) => s.deleteCollection);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const pushToast = useAppStore((s) => s.pushToast);
  const [form, setForm] = useState<{ editing: Collection | null } | null>(null);
  const formDirty = useRef(false);

  const closeForm = () => setForm(null);
  /** Escape, the overlay and the close button: unsaved input is only thrown away on request. */
  const requestCloseForm = () => {
    if (!formDirty.current) {
      closeForm();
      return;
    }
    requestConfirm({
      title: t.common.discardTitle,
      message: t.common.discardMessage,
      confirmLabel: t.common.discard,
      danger: true,
      onConfirm: closeForm,
    });
  };

  const membersById = useMemo(() => {
    const map = new Map<string, Resource[]>();
    for (const collection of collections)
      map.set(collection.id, collectionMembers(collection, resources));
    return map;
  }, [collections, resources]);

  const confirmDelete = (collection: Collection) =>
    requestConfirm({
      title: t.collections.deleteTitle,
      message: fmt(t.collections.deleteMessage, { name: collection.name }),
      confirmLabel: t.common.delete,
      danger: true,
      onConfirm: () => {
        deleteCollection(collection.id);
        pushToast(t.collections.deleted, 'success');
      },
    });

  return (
    <div className="mx-auto max-w-6xl pb-24">
      <PageHeader
        title={t.collections.title}
        description={t.collections.subtitle}
        actions={
          collections.length > 0 ? (
            <Button variant="primary" icon={FolderPlus} onClick={() => setForm({ editing: null })}>
              {t.collections.newCollection}
            </Button>
          ) : null
        }
      />

      {collections.length === 0 ? (
        <EmptyState
          icon={Folder}
          title={t.collections.emptyTitle}
          description={
            <>
              {t.collections.emptyText}
              <span className="mt-2 block text-sm">{t.collections.emptyExample}</span>
            </>
          }
          actions={
            <Button variant="primary" icon={FolderPlus} onClick={() => setForm({ editing: null })}>
              {t.collections.createFirst}
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {collections.map((collection) => (
            <li key={collection.id} className="h-full">
              <CollectionCard
                collection={collection}
                members={membersById.get(collection.id) ?? []}
                onEdit={() => setForm({ editing: collection })}
                onDelete={() => confirmDelete(collection)}
              />
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={form !== null}
        onClose={requestCloseForm}
        title={form?.editing ? t.collections.editTitle : t.collections.createTitle}
        description={t.collections.formHint}
        size="lg"
      >
        {form && (
          <CollectionForm
            editing={form.editing}
            resources={resources}
            onClose={closeForm}
            onDirtyChange={(dirty) => {
              formDirty.current = dirty;
            }}
          />
        )}
      </Modal>
    </div>
  );
};

export default CollectionsView;
