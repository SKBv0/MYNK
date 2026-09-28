import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and must be able to print Rust errors to the terminal.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 7426,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // Cargo rewrites files here while running; watching them crashes the watcher with EBUSY.
      ignored: ['**/src-tauri/**'],
    },
  },
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
