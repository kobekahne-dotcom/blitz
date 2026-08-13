import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/blitz/',
  // keep identifier names through minification: a production-only crash that
  // reports "Cannot access 'fn' before initialization" is undebuggable, and
  // the size cost is a couple of kilobytes
  esbuild: { keepNames: true },
  build: { sourcemap: true },
})
