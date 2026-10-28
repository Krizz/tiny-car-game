import { defineConfig } from 'vite'

// Served BUILT by server.ts (Bun): `bun run build` after every edit.
export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
})
