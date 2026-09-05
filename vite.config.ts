import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri espera un puerto fijo y falla si no está disponible
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: {
      // src-tauri lo vigila el propio Tauri
      ignored: ['**/src-tauri/**'],
    },
    // Necesario para que SharedArrayBuffer esté disponible en el WebView
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  // web-ifc y fragments traen binarios .wasm que no deben pre-empaquetarse
  optimizeDeps: {
    exclude: ['web-ifc', '@thatopen/fragments'],
  },

  worker: {
    format: 'es',
  },

  build: {
    // El WebView de Tauri en Windows es Chromium moderno
    target: 'esnext',
    // Siempre minificado y sin sourcemaps, incluso en builds de depuracion:
    // Tauri incrusta todo dist/ dentro del ejecutable, y los mapas de
    // three.js y fragments lo llevaban de 18 MB a mas de 60 MB, con el
    // consiguiente castigo en el tiempo de compilacion de Rust.
    minify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
})
