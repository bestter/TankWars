import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/.wrangler/**', '**/node_modules/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
  },
  // Réserver les règles React et les globals navigateur au client.
  // Le Worker utilise ses propres globals et des exceptions ciblées
  // pour les paramètres inutilisés et les exclusions par déstructuration.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['worker/**'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['worker/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.worker,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
])
