import { build } from 'vite';
import { expect, it } from 'vitest';

it('builds a static contact entry with the same project-scoped assets as the menu', async () => {
  const result = await build({
    mode: 'github-pages',
    base: '/TankWars/',
    logLevel: 'silent',
    build: { write: false, reportCompressedSize: false },
  });
  if (!('output' in result)) throw new Error('Expected one Vite build output');

  const menu = result.output.find(asset => asset.fileName === 'index.html');
  const contact = result.output.find(asset => asset.fileName === 'contact/index.html');
  expect(menu?.type).toBe('asset');
  expect(contact).toMatchObject({
    type: 'asset',
    source: expect.stringMatching(/src="\/TankWars\/assets\/[^"]+\.js"/),
  });
  if (menu?.type !== 'asset' || contact?.type !== 'asset') return;
  expect(contact.source).toBe(menu.source);
}, 15_000);
