import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Updates never reload mid-use: src/main.jsx applies one quietly when it's safe (coming back
      // after a while, or right at launch), and otherwise offers it with an "Update" toast.
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Daybook',
        short_name: 'Daybook',
        description: 'Tasks, calendar, people, journal and an AI assistant in one place.',
        theme_color: '#F2F2F7',
        background_color: '#F2F2F7',
        display: 'standalone',
        display_override: ['standalone'],
        orientation: 'portrait',
        scope: '/',
        start_url: '/#/today',
        categories: ['productivity', 'lifestyle'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // Full bleed with the mark inside the safe zone, for Android's shaped icons (scripts/make_icons.py).
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Assistant', url: '/#/assistant', icons: [{ src: 'icon-192.png', sizes: '192x192' }] },
          { name: 'Tasks', url: '/#/tasks', icons: [{ src: 'icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // Every page chunk is precached so the installed app opens offline.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        // Launch images (16 PNGs, scripts/make_launch.py) are only read by iOS when the Home Screen
        // app starts, so they stay out of the precache.
        globIgnores: ['**/node_modules/**/*', 'launch/**'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // Push notifications (public/push-sw.js).
        importScripts: ['push-sw.js'],
      },
    }),
  ],
})
