import { defineConfig, type Plugin } from 'vite'
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

function githubPagesContactEntry(): Plugin {
  return {
    name: 'tankwars-github-pages-contact-entry',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const index = bundle['index.html']
        if (index?.type !== 'asset') this.error('Missing index.html for the GitHub Pages contact entry')
        this.emitFile({ type: 'asset', fileName: 'contact/index.html', source: index.source })
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId()) },
  plugins: [react(), mode === 'github-pages' && githubPagesContactEntry()],
  base: '/',
}))
