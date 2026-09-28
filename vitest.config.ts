import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// One zone with DST on every machine: date text matches everywhere and DST cases really cross one.
process.env.TZ = 'America/New_York';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // One jsdom per worker instead of per file; rebuilding it per file dominates suite time.
      pool: 'vmThreads',
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
        reporter: ['text-summary', 'html', 'lcov'],
      },
    },
  }),
);
