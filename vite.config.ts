/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { CSP } from './csp.mjs'

/** Adds the CSP <meta> tag to production builds (Vite's dev server needs inline scripts). */
function cspMeta(): Plugin {
  return {
    name: 'vaultdiary-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

export default defineConfig({
  // Relative base: the same build works at the Firebase root and under /<repo>/ on GitHub Pages.
  base: './',
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 800 },
  plugins: [
    react(),
    cspMeta(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Vault Diary',
        short_name: 'Vault Diary',
        description: 'A private, end-to-end encrypted diary stored in your own Google Drive.',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#15171a',
        theme_color: '#1f2937',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // recovery.html is a download, not part of the app shell.
        globIgnores: ['recovery.html'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/recovery\.html$/],
        // Never cache Google requests in the service worker.
        runtimeCaching: [],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
