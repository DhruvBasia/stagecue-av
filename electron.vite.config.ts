import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Strict Content-Security-Policy injected into the production HTML only.
 * The dev server needs inline module preambles for React Fast Refresh, so the
 * policy is not applied during `electron-vite dev`.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: local-media:",
  "media-src 'self' blob: local-media:",
  "font-src 'self' data:",
  "connect-src 'self' local-media:",
  // Web-page cues: the stage embeds http(s) pages in a sandboxed <webview> (main process enforces the rest).
  'frame-src http: https:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function productionCspPlugin(): Plugin {
  return {
    name: 'stagecue-production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP },
          injectTo: 'head-prepend'
        }
      ];
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), productionCspPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          stage: resolve('src/renderer/stage.html')
        }
      }
    }
  }
});
