/** Fills jsdom's gaps (no layout engine, ResizeObserver or matchMedia) with deterministic stubs. */

export const VIEWPORT_WIDTH = 1200;
export const VIEWPORT_HEIGHT = 900;

type MediaMatches = Record<string, boolean>;

let mediaMatches: MediaMatches = {};

/** Makes the given media queries match (e.g. `{ '(min-width: 1440px)': true }`). */
export const setMediaMatches = (matches: MediaMatches): void => {
  mediaMatches = { ...matches };
};

let installed = false;

const defineSize = (name: 'clientWidth' | 'clientHeight', value: number) => {
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    get(this: HTMLElement) {
      const override = this.dataset.testSize;
      if (override) {
        const [w, h] = override.split('x').map(Number);
        return name === 'clientWidth' ? w : h;
      }
      return value;
    },
  });
};

/** Installs the stubs once per test file (idempotent). */
export const installDomStubs = (): void => {
  if (installed) return;
  installed = true;

  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;

  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: mediaMatches[query] ?? false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;

  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;

  defineSize('clientWidth', VIEWPORT_WIDTH);
  defineSize('clientHeight', VIEWPORT_HEIGHT);

  if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:mynk-test';
    URL.revokeObjectURL = () => undefined;
  }

  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  }
};

/** A `File` whose `text()` works in jsdom regardless of Blob support. */
export const textFile = (name: string, content: string, type = 'text/html'): File => {
  const file = new File([content], name, { type });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) });
  return file;
};

/** An image `File` with a controllable size and readable bytes. */
export const imageFile = (name: string, type: string, size = 1024): File => {
  const file = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new ArrayBuffer(4)) });
  return file;
};
