import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Strict Content-Security-Policy for the packaged app. Only added at build time,
// because the dev server needs an inline script for React fast-refresh.
const csp = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />`
    ),
};

// base: './' so the built index.html works when Electron loads it from disk.
export default defineConfig({
  plugins: [react(), csp],
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
