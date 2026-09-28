import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Without vitest globals, Testing Library cannot register its own unmount-after-each hook.
afterEach(() => cleanup());
