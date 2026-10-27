import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./web', import.meta.url));

export default defineConfig(({ mode }) => {
  // `vite build --mode replay` (via npm run build:static): read-only recorded replay for static hosting.
  const replay = mode === 'replay';
  return {
    root,
    plugins: [react()],
    base: replay ? './' : '/',
    define: replay ? { 'import.meta.env.VITE_ANVIL_REPLAY': JSON.stringify('1') } : {},
    // The shared core hashes with node:crypto; in the browser bundle (only the replay's
    // in-page adapter validation reaches it) a tiny pure-JS SHA-256 stands in.
    resolve: { alias: { 'node:crypto': fileURLToPath(new URL('./web/src/shims/crypto.ts', import.meta.url)) } },
    build: {
      outDir: fileURLToPath(new URL(replay ? './dist-static' : './dist/web', import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:4317',
      },
    },
  };
});
