import React, { useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { useAddResource } from '../hooks/useAddResource';
import { Button, Input, Modal } from './ui';

const AddLinkDialog: React.FC = () => {
  const isOpen = useAppStore((s) => s.activeModal === 'addLink');
  const closeModal = useAppStore((s) => s.closeModal);
  const { t } = useTranslation();

  return (
    <Modal open={isOpen} onClose={closeModal} title={t.addLink.title} size="md">
      <AddLinkForm onClose={closeModal} />
    </Modal>
  );
};

const AddLinkForm: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const addResource = useAddResource();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim() || submitting) return;
    setSubmitting(true);
    try {
      const outcome = addResource(url);
      if (outcome === 'invalid') setError(t.addLink.invalidUrl);
      else onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      <Input
        data-autofocus
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://"
        label={t.addLink.label}
        icon={Link2}
        size="lg"
        value={url}
        error={error ?? undefined}
        hint={t.addLink.hint}
        onChange={(e) => {
          setUrl(e.target.value);
          if (error) setError(null);
        }}
      />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t.common.cancel}</Button>
        <Button
          type="submit"
          variant="primary"
          icon={Plus}
          loading={submitting}
          disabled={!url.trim()}
        >
          {t.addLink.submit}
        </Button>
      </div>
    </form>
  );
};

export default AddLinkDialog;
