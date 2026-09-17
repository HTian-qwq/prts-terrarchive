import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'lib/rhine',
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./ui/rhine/index.ts', import.meta.url)),
      name: '__PRTS_RHINE__',
      formats: ['iife'],
      fileName: () => 'rhine.js',
      cssFileName: 'rhine',
    },
    sourcemap: false,
  },
})
