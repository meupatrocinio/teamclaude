import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnServer } from '../test-helpers/spawn-server.js';

// AI-1960 (the AI-1903 review fix), end to end through the real server: a
// POST /teamclaude/reload that swaps proxy.clientKeys must run the MITM
// tunnel-listener evictor in the same synchronous stretch (doReload, index.js),
// so a tunnel authenticated under a just-rotated key is torn down, not leaked.

const T = { timeout: 60000 };
const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');

// Open a CONNECT tunnel to the upstream host (rewrite mode mints the
// terminating listener) and hold the raw socket open — no TLS needed.
async function openTunnel(proxyPort, target, key) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await once(raw, 'connect');
  raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(`:${key}`)}\r\n\r\n`);
  const closed = once(raw, 'close').then(() => true);
  let buf = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      resolve();
    };
    raw.on('data', onData);
    raw.once('error', reject);
  });
  assert.match(buf.toString('utf8').split('\r\n')[0], / 200 /, 'the CONNECT was answered');
  return { raw, closed };
}

test('a reload rotating a client key destroys tunnels authenticated under the old key', T, async () => {
  const srv = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }] },
      upstream: 'http://127.0.0.1:1', // never contacted: no request is sent inside the tunnel
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  let tunnel = null;
  try {
    // The CONNECT target must be the upstream host for rewrite mode (which is
    // what binds the listener, and the keyHash, to the tunnel).
    const target = '127.0.0.1:1';
    tunnel = await openTunnel(srv.port, target, 'ana-key');

    // Rotate the key on disk, then reload through the control endpoint.
    const disk = JSON.parse(await readFile(srv.configPath, 'utf8'));
    disk.proxy.clientKeys = [{ name: 'ana', key: 'ana-key-v2' }];
    await writeFile(srv.configPath, JSON.stringify(disk));
    const res = await fetch(`http://127.0.0.1:${srv.port}/teamclaude/reload`, {
      method: 'POST', headers: { 'x-api-key': 'admin-key' },
    });
    assert.equal(res.status, 200);
    await res.text();

    // The old key's listener is evicted and its held-open tunnel destroyed.
    const timeout = new Promise((r) => setTimeout(() => r(false), 10_000));
    assert.equal(await Promise.race([tunnel.closed, timeout]), true, 'the stale tunnel survived the rotation');

    // A tunnel under the NEW key still opens (the reload left the path live).
    const fresh = await openTunnel(srv.port, target, 'ana-key-v2');
    fresh.raw.destroy();
    await fresh.closed;
  } finally {
    tunnel?.raw.destroy();
    await srv.stop();
  }
});
