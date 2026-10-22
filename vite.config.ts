import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'

function buildId(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? '-dirty' : ''
    return `${sha}${dirty}/${new Date().toISOString()}`
  } catch {
    return `unknown/${new Date().toISOString()}`
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId()) },
  plugins: [react()],
  base: '/',
})
