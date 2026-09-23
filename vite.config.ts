/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Vendor chunking for the main bundle: three + R3F/drei (~1.1 MB gzip 300 kB) and React are split
 * from the app code so they cache across releases. Lazily loaded three loaders (GLTFLoader) keep
 * their own on-demand chunk. Workers (step.worker, plan.worker) are separate builds.
 */
function vendorGroup(id: string): string | null {
  if (!id.includes('node_modules')) return null
  if (/[\\/]three[\\/]examples[\\/]jsm[\\/]loaders[\\/]/.test(id)) return null // lazy GLTF/STL loaders stay lazy
  if (/[\\/]node_modules[\\/](three|three-stdlib|@react-three|react-reconciler|its-fine|suspend-react|maath|camera-controls|detect-gpu|stats-gl|meshline|troika-[a-z-]+|@mediapipe|tunnel-rat|hls\.js|webgl-sdf-generator|bidi-js)[\\/]/.test(id)) return 'three'
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/.test(id)) return 'react'
  if (/[\\/]node_modules[\\/]occt-import-js[\\/]/.test(id)) return null // lazily loaded on the first STEP import
  return 'vendor'
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    // occt-import-js is an emscripten UMD bundle; let esbuild pre-bundle it to ESM.
    include: ['occt-import-js'],
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
  preview: {
    port: 4173,
    proxy: { '/api': 'http://localhost:8080' },
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: vendorGroup, minSize: 20 * 1024 }],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**', 'scratch/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
