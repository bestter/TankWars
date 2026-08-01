import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      'cloudflare:workers': '/worker/__mocks__/cloudflare-workers.ts'
    }
  }
})
