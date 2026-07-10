import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// GitHub Pages serves a project repo under /<repo>/, so the built asset URLs
// need that prefix. Locally and on any root-domain host it stays '/'. CI sets
// BASE_PATH; `import.meta.env.BASE_URL` then carries it into the router.
const base = process.env.BASE_PATH || '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
