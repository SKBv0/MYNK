import { beforeEach, describe, expect, it } from 'vitest';
import { errorMessage } from './errors';
import { IpcError } from '../services/ipc';
import { CorruptLibraryError, FutureVersionError } from '../store/migrate';
import { useAppStore } from '../store';
import { translations } from '../translations';

beforeEach(() => {
  useAppStore.setState({ lang: 'en' });
});

describe('errorMessage', () => {
  it("appends the provider's own error description", () => {
    expect(errorMessage(new IpcError('provider', 'model not found', 404))).toBe(
      `${translations.en.errors.providerStatus} (model not found)`,
    );
    expect(errorMessage(new IpcError('notFound', 'Resource was removed.'))).toBe('Not found.');
  });

  it('never shows raw backend text for the other kinds, in either language', () => {
    const raw = {
      storage: 'The process cannot access the file (os error 32)',
      parse: 'expected value at line 1 column 1',
      internal: 'mutex poisoned',
      invalidInput: 'image content does not match its extension',
    } as const;
    for (const [kind, message] of Object.entries(raw) as [keyof typeof raw, string][]) {
      expect(errorMessage(new IpcError(kind, message))).toBe(translations.en.errors[kind]);
    }
    useAppStore.setState({ lang: 'tr' });
    expect(errorMessage(new IpcError('storage', raw.storage))).toBe(
      'Yerel veriler okunamadı ya da yazılamadı.',
    );
    expect(errorMessage(new IpcError('invalidInput', raw.invalidInput))).toBe(
      'Girilen değer geçersiz.',
    );
  });

  it('keeps the cause of a network failure after the translated sentence', () => {
    const message = errorMessage(
      new IpcError('network', 'Could not fetch the page: stream error received: internal error'),
    );
    expect(message).toBe(
      'Could not reach the server. Check your internet connection. (Could not fetch the page: stream error received: internal error)',
    );
  });

  it('translates the detail of errors the frontend raised itself', () => {
    const message = errorMessage(new FutureVersionError(9));
    expect(message).toContain('Could not read or write local data.');
    expect(message).toContain('format v9');
    expect(message).toContain('v3');
    expect(message).not.toContain('Refusing');
  });

  it('translates those details into the active language', () => {
    useAppStore.setState({ lang: 'tr' });
    expect(errorMessage(new FutureVersionError(9))).toContain('daha yeni bir sürümüyle yazılmış');
    expect(errorMessage(new CorruptLibraryError('has a damaged "chats" section'))).toContain(
      'bozuk ya da bir MYNK kütüphane dosyası değil',
    );
    expect(
      errorMessage(
        new IpcError('parse', 'Keyword suggestion response was not JSON.').withDetail({
          key: 'keywordsNotJson',
        }),
      ),
    ).toBe('Yanıt anlaşılamadı. (anahtar kelime önerisi JSON değildi)');
  });

  it('has a string for every detail key in both languages', () => {
    expect(Object.keys(translations.tr.errors.details).sort()).toEqual(
      Object.keys(translations.en.errors.details).sort(),
    );
    expect(Object.keys(translations.tr.errors.codes).sort()).toEqual(
      Object.keys(translations.en.errors.codes).sort(),
    );
  });

  it('translates the config errors Rust marked with a code, hiding the English text', () => {
    // Mirrors how Rust serializes this rejection for a model that was never pulled.
    const missing = {
      kind: 'config',
      message:
        'Model "qwen3:8b" is not installed on the Ollama server. Pull it with `ollama pull qwen3:8b` or choose another model.',
      code: 'modelMissing',
      model: 'qwen3:8b',
    };
    const english = errorMessage(missing);
    expect(english).toContain('“qwen3:8b” is not installed in Ollama');
    expect(english).toContain('ollama pull qwen3:8b');
    expect(english).not.toContain('is not installed on the Ollama server');
    expect(english).not.toContain(translations.en.errors.config);

    useAppStore.setState({ lang: 'tr' });
    expect(errorMessage(missing)).toContain('“qwen3:8b” modeli Ollama’da kurulu değil');
    expect(errorMessage({ ...missing, code: 'notChatModel', model: 'bge-m3:latest' })).toContain(
      'bir gömme (embedding) modeli',
    );
    expect(errorMessage({ ...missing, code: 'somethingElse' })).toBe(translations.tr.errors.config);
  });

  it('tells the user Ollama is not running instead of a generic network failure', () => {
    const refused = {
      kind: 'network',
      message: 'error sending request for url (http://127.0.0.1:11434/api/chat)',
      code: 'ollamaUnreachable',
    };
    // The code carries no model, so the template must not leave a placeholder behind.
    expect(errorMessage(refused)).toBe(
      'Could not connect to Ollama. Make sure Ollama is running, then try again.',
    );
    expect(errorMessage(refused)).not.toContain('{model}');

    useAppStore.setState({ lang: 'tr' });
    expect(errorMessage(refused)).toBe(translations.tr.errors.codes.ollamaUnreachable);
    expect(errorMessage(refused)).not.toBe(translations.tr.errors.network);
  });

  it('gives a dead link its own reason instead of the generic network sentence', () => {
    const dead = {
      kind: 'network',
      message: 'Could not fetch the page: the host old-site.example could not be found',
      code: 'hostNotFound',
    };
    expect(errorMessage(dead)).toBe('The site’s address could not be found.');
    expect(errorMessage(dead)).not.toContain('old-site.example');
    expect(errorMessage({ ...dead, code: 'tlsCertificate' })).toBe(
      translations.en.errors.codes.tlsCertificate,
    );

    useAppStore.setState({ lang: 'tr' });
    expect(errorMessage({ ...dead, code: 'tlsHandshake' })).toBe(
      'Site eski bir bağlantı protokolü kullanıyor.',
    );
    expect(errorMessage(dead)).not.toBe(translations.tr.errors.network);
  });

  it('adds no empty parentheses when the provider sent an empty error body', () => {
    expect(errorMessage(new IpcError('provider', 'Ollama returned HTTP 502.', 502))).toBe(
      translations.en.errors.providerStatus,
    );
    expect(errorMessage(new IpcError('provider', 'Ollama returned HTTP 502:', 502))).toBe(
      translations.en.errors.providerStatus,
    );
    expect(errorMessage(new IpcError('provider', 'Ollama returned HTTP 500: boom', 500))).toContain(
      '(Ollama returned HTTP 500: boom)',
    );
  });
});
