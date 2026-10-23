// @vitest-environment node
/// <reference types="node" />
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

describe('Worker ESLint coverage', () => {
  const eslint = new ESLint();

  it('analyzes Worker sources, tests and mocks', async () => {
    for (const file of [
      'worker/src/index.ts',
      'worker/src/game-room.ts',
      'worker/src/rate-limiter.ts',
      'worker/src/__tests__/game-room.test.ts',
      'worker/__mocks__/cloudflare-workers.ts',
    ]) {
      expect(await eslint.isPathIgnored(file), file).toBe(false);
    }
  });

  it('detects unused Worker code without rewriting files', async () => {
    const [result] = await eslint.lintText('const unusedWorkerValue = 1;\n', {
      filePath: 'worker/src/lint-probe.ts',
    });
    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: '@typescript-eslint/no-unused-vars', severity: 2 }),
    ]));
  });

  it('ignores generated output and Wrangler state', async () => {
    for (const file of [
      'dist/generated.ts',
      'dist-ssr/generated.ts',
      'worker/dist/generated.ts',
      'worker/.wrangler/tmp/generated.ts',
      'worker/node_modules/dependency/index.ts',
    ]) {
      expect(await eslint.isPathIgnored(file), file).toBe(true);
    }
  });

  it('keeps Worker globals and unused-variable exceptions separate from React', async () => {
    const worker = await eslint.calculateConfigForFile('worker/src/game-room.ts');
    const client = await eslint.calculateConfigForFile('src/App.tsx');
    expect(worker.languageOptions.globals).toHaveProperty('crypto');
    expect(worker.languageOptions.globals).not.toHaveProperty('window');
    expect(client.languageOptions.globals).toHaveProperty('window');
    expect(worker.rules).not.toHaveProperty('react-hooks/rules-of-hooks');
    expect(client.rules).toHaveProperty('react-hooks/rules-of-hooks');
    expect(worker.rules['@typescript-eslint/no-unused-vars']).toEqual([
      2, { argsIgnorePattern: '^_', ignoreRestSiblings: true },
    ]);
    expect(client.rules['@typescript-eslint/no-unused-vars']).toEqual([2]);
  });
});
