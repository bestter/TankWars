// Local-only smoke: real Cloudflare primitive and real Worker WebSocket route.
// Start `npm run worker:dev -- --local` first. Never print invitation credentials.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundle = await build({
  stdin: { contents: `import { tokenMatches } from './worker/src/tokenComparison.ts';
    export default { fetch() {
      const tests = [tokenMatches('synthetic', 'synthetic'),
        !tokenMatches('Synthetic', 'synthetic'), !tokenMatches('synthetiC', 'synthetic'),
        !tokenMatches('synthEtic', 'synthetic'), !tokenMatches('', 'synthetic'),
        !tokenMatches('long-synthetic', 'synthetic'), !tokenMatches('é', 'synthetic'),
        !tokenMatches('synthetic', undefined), !tokenMatches('synthetic', '')];
      return Response.json({ passed: tests.every(Boolean), cases: tests.length });
    } };`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const runtime = new Miniflare({ workers: [{ config: { name: 'token-comparison-smoke',
  compatibilityDate: '2026-06-16', manifest: { mainModule: 'index.js', modulesRoot: '/',
    modules: { 'index.js': { type: 'esm', contents: bundle.outputFiles[0].text } } } } }] });
try {
  const result = await (await runtime.dispatchFetch('http://local.test/')).json();
  assert.equal(result.passed, true);
  console.log(`workerd primitive: ${result.cases} cases passed`);
} finally { await runtime.dispose(); }

const base = 'http://127.0.0.1:8787';
const response = await fetch(`${base}/api/rooms`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
  body: JSON.stringify({ numPlayers: 2, slots: [{ type: 'human' }, { type: 'human' }] }),
});
assert.equal(response.status, 200);
if (!response.ok) throw new Error('Local room creation failed');
const room = await response.json();
const invitation = new URL(room.slots[0].url);
const token = invitation.searchParams.get('token');
const path = `${base}/api/rooms/${room.roomId}/ws?protocolVersion=4&slot=0&token=`;
const socket = new WebSocket(path.replace('http:', 'ws:') + encodeURIComponent(token) + '&name=Smoke');
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Valid local WebSocket rejected')), { once: true });
  });
  await Promise.all(['', 'x', token + 'long', 'é', 'X' + token.slice(1),
    token.slice(0, 10) + 'X' + token.slice(11), token.slice(0, -1) + 'X'].map(async bad => {
    const status = await new Promise((resolve, reject) => {
      const req = request(path + encodeURIComponent(bad), { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } }, res => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('upgrade', (_res, connection) => { connection.destroy(); reject(new Error('Invalid token accepted')); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, bad === '' ? 400 : 403);
    assert.equal(socket.readyState, WebSocket.OPEN);
  }));
  console.log('Worker route: valid connection accepted; 7 refusals preserve its socket');
} finally { socket.close(); }
