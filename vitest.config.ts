import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      'cloudflare:workers': resolve(import.meta.dirname, 'worker/__mocks__/cloudflare-workers.ts')
    }
  },
});
