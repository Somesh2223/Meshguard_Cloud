import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// The backend (server/) runs on 8080 locally and behind Caddy on EC2.
const API_TARGET = process.env.API_TARGET || 'http://localhost:8080'

export default defineConfig({
  define: {
    'process.env': {},
  },
  server: {
    proxy: {
      '/api': API_TARGET,
      '/ws': { target: API_TARGET, ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-ready-icon.svg'],
      workbox: {
        // The victim app works offline; the rescuer dashboard and API must always hit the server.
        navigateFallbackDenylist: [/^\/dashboard/, /^\/api/, /^\/ws/],
        globIgnores: ['**/dashboard*'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        name: 'MeshGuard SOS: Disaster Rescue',
        short_name: 'MeshGuard SOS',
        description: 'Offline mesh SOS that reaches cloud rescue coordination as soon as any phone gets internet',
        theme_color: '#0f172a',
        background_color: '#020617',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
})
