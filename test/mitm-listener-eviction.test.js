import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { AccountManager } from '../src/account-manager.js';

// AI-1960 (the AI-1903 review fix): the MITM getServer memo is keyed with the
// CONNECT-time keyHash, so a client-key rotation leaked one listener — and its
// live tunnels — per old hash for the process's lifetime. The evictor, run from
// doReload in the same synchronous stretch as the clientKeys swap, drops every
// entry whose keyHash left the valid set, closes its server and destroys its
// tracked tunnel sockets; entries with an empty keyHash segment (shared apiKey,
// open gate, loopback exemption) survive.

const T = { timeout: 30000 };
const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const closeHard = (s) => { s?.closeAllConnections?.(); try { s?.close(); } catch { /* closing */ } };
const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

async function setup() {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }, { name: 'ben', key: 'ben-key' }] },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const proxy = http.createServer();
  allowLoopbackForward(proxy);
  const handler = createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} });
  proxy.on('connect', handler);
  const proxyPort = await listen(proxy);
  return { proxy, handler, proxyPort, upPort, upstream, caCertPem };
}

// Open a CONNECT tunnel and keep the raw socket open (no TLS handshake needed:
// the socket is tracked from the moment the memo entry takes it).
async function openTunnel(proxyPort, target, proxyAuth = null) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await once(raw, 'connect');
  raw.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
    (proxyAuth ? `Proxy-Authorization: ${proxyAuth}\r\n` : '') + '\r\n',
  );
  const closed = once(raw, 'close').then(() => true);
  // The 200 line: read exactly to the header terminator, then stop listening —
  // the tunnel is raw bytes from here, and we want it simply held open.
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
  assert.ok(buf.toString('utf8').split('\r\n')[0].includes(' 200 '), 'the CONNECT was answered');
  // Give the proxy a tick to register the socket against its memo entry.
  for (let i = 0; i < 50 && !raw.readableEnded; i++) await new Promise(r => setImmediate(r));
  return { raw, closed };
}

test('a key rotation evicts the stale listener and destroys its held-open tunnel; empty-keyHash entries survive', T, async () => {
  const { proxy, handler, proxyPort, upPort, upstream } = await setup();
  const tunnels = [];
  try {
    const target = `127.0.0.1:${upPort}`;
    tunnels.push(await openTunnel(proxyPort, target, basic(':ana-key')));
    tunnels.push(await openTunnel(proxyPort, target, basic(':ben-key')));
    tunnels.push(await openTunnel(proxyPort, target)); // loopback, no key: empty keyHash
    assert.equal(handler.tunnelListenerCount(), 3, 'one listener per (pin, client, keyHash)');

    // The reload swaps ana-key out for ana-key-v2 (a rotation) and drops ben.
    handler.evictStaleTunnels({ apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key-v2' }] });

    assert.equal(handler.tunnelListenerCount(), 1, 'both removed-key entries are gone; the loopback one survives');
    assert.equal(await tunnels[1].closed, true, 'ben\'s held-open tunnel was destroyed');
    assert.equal(await tunnels[0].closed, true, 'ana\'s old-key tunnel was destroyed');
    assert.ok(!tunnels[2].raw.destroyed, 'the empty-keyHash tunnel is still open');
  } finally {
    for (const t of tunnels) t.raw.destroy();
    closeHard(proxy); closeHard(upstream);
  }
});

test('N rotations leave the memo bounded', T, async () => {
  const { proxy, handler, proxyPort, upPort, upstream } = await setup();
  const tunnels = [];
  try {
    const target = `127.0.0.1:${upPort}`;
    let current = ['ana-key'];
    for (let i = 0; i < 8; i++) {
      const key = `ana-key-v${i}`;
      tunnels.push(await openTunnel(proxyPort, target, basic(`:${key}`)));
      // The rotation swap: only the newest key is valid afterwards.
      handler.evictStaleTunnels({ apiKey: 'admin-key', clientKeys: [{ name: 'ana', key }] });
      current = [key];
      assert.ok(handler.tunnelListenerCount() <= current.length + 1,
        `after rotation ${i}: ${handler.tunnelListenerCount()} listeners for ${JSON.stringify(current)}`);
    }
    assert.equal(handler.tunnelListenerCount(), 1, 'only the live key\'s listener remains');
  } finally {
    for (const t of tunnels) t.raw.destroy();
    closeHard(proxy); closeHard(upstream);
  }
});

test('the evictor is threaded onto the proxy server for the reload path', T, async () => {
  // createProxyServer exposes what index.js doReload calls after the clientKeys
  // swap; a headless server without the wiring would fail the reload-side fix.
  const { createProxyServer } = await import('../src/server.js');
  const am = new AccountManager([oauth('qa')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const srv = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1' });
  try {
    assert.equal(typeof srv.evictStaleMitmTunnels, 'function');
    assert.equal(typeof srv.mitmTunnelListenerCount, 'function');
  } finally {
    closeHard(srv);
  }
});
