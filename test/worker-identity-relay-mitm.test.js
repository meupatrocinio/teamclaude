import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// AI-1960 (E8/E9, contract W2): the worker-id header is stripped on EVERY
// upstream-bound path — the absolute-form relay (relayHttpForward), the
// client-credential relay (relayStream), the WebSocket relay (relayUpgrade,
// base and MITM) — and a malformed value is a non-unified 400 through every
// listener that can express one (the MITM h2/h1 listener included; the
// WebSocket upgrade handshakes are strip-only, no JSON 400 exists there).

const T = { timeout: 30000 };
const HOUR = 3600_000;
const W1 = 'w1_' + 'a'.repeat(32);
const BAD = 'w1_NOT-HEX';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const closeHard = (s) => { s?.closeAllConnections?.(); try { s?.close(); } catch { /* closing */ } };
const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

function makeWitness() {
  const requests = [];
  const upgrades = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', () => {});
  });
  return { server, requests, upgrades };
}

async function withProxy(fn) {
  const witness = makeWitness();
  const upPort = await listen(witness.server);
  const am = new AccountManager([oauth('qa')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }] },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const proxy = createProxyServer(am, config);
  allowLoopbackForward(proxy); // the relay targets below are on this machine
  const port = await listen(proxy);
  try {
    await fn({ port, upPort, witness, am, config });
  } finally {
    closeHard(proxy); closeHard(witness.server);
  }
}

test('relayHttpForward strips the header and 400s a malformed one before the relay', T, async () => {
  await withProxy(async ({ port, upPort, witness }) => {
    // An absolute-form request line: what a tool using us as HTTP_PROXY sends.
    const relay = (worker) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'GET',
        path: `http://127.0.0.1:${upPort}/anything`,
        headers: { 'x-api-key': 'ana-key', ...(worker === undefined ? {} : { 'x-teamclaude-worker-id': worker }) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    const ok = await relay(W1);
    assert.equal(ok.status, 200);
    assert.equal(witness.requests.length, 1);
    assert.equal(witness.requests[0]['x-teamclaude-worker-id'], undefined, 'the header reached the relay target');

    const bad = await relay(BAD);
    assert.equal(bad.status, 400);
    assert.equal(bad.headers['x-should-retry'], 'false');
    assert.equal(JSON.parse(bad.body)?.error?.type, 'invalid_request_error');
    assert.equal(witness.requests.length, 1, 'the malformed request never reached the relay target');
  });
});

test('relayStream (client-credential path) strips the header', T, async () => {
  await withProxy(async ({ port, witness }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/oauth/profile`, {
      headers: { 'x-api-key': 'ana-key', 'x-teamclaude-worker-id': W1, authorization: 'Bearer client-own' },
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(witness.requests.length, 1);
    assert.equal(witness.requests[0]['x-teamclaude-worker-id'], undefined, 'the header reached upstream');
    assert.equal(witness.requests[0].authorization, 'Bearer client-own', 'the client credential still rides');
  });
});

test('relayUpgrade on the base listener strips the header (strip-only: no 400 mid-upgrade)', T, async () => {
  await withProxy(async ({ port, witness }) => {
    const upgrade = (worker) => new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('error', reject);
      sock.once('connect', () => sock.write(
        'GET /v1/session_ingress/ws/abc HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        (worker === undefined ? '' : `x-teamclaude-worker-id: ${worker}\r\n`) + '\r\n',
      ));
      const onData = (d) => {
        if (!d.includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);
        sock.destroy();
        resolve(d.toString('utf8').split('\r\n')[0]);
      };
      sock.on('data', onData);
    });
    // Even a malformed value is stripped (the handshake has no JSON 400); the
    // valid one proves the strip on the ordinary path.
    for (const worker of [W1, BAD]) {
      const statusLine = await upgrade(worker);
      assert.match(statusLine, /101 Switching Protocols/);
    }
    assert.equal(witness.upgrades.length, 2);
    for (const headers of witness.upgrades) {
      assert.equal(headers['x-teamclaude-worker-id'], undefined, 'the header reached the upgrade target');
    }
  });
});

// ── the MITM tunnel ──────────────────────────────────────────────────────────

function connectThroughProxy(proxyPort, target, caCertPem, proxyAuth, alpn = ['h2']) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
      (proxyAuth ? `Proxy-Authorization: ${proxyAuth}\r\n` : '') + '\r\n',
    ));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(status)); return; }
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: alpn }, () => resolve(sock));
      sock.once('error', reject);
    };
    raw.on('data', onData);
  });
}

test('the MITM tunnel strips the header and 400s a malformed one (h2)', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const witness = makeWitness();
  const upPort = await listen(witness.server);
  const am = new AccountManager([oauth('qa')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }] },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} }));
  const mitmPort = await listen(mitm);

  const viaTunnel = async (worker) => {
    const sock = await connectThroughProxy(mitmPort, `127.0.0.1:${upPort}`, caCertPem, basic(':ana-key'));
    const client = http2.connect('https://localhost', { createConnection: () => sock });
    try {
      const req = client.request({
        ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json',
        'x-claude-code-session-id': 'tun-w',
        ...(worker === undefined ? {} : { 'x-teamclaude-worker-id': worker }),
      });
      let status = 0;
      let retry = null;
      let body = '';
      req.on('response', (h) => { status = Number(h[':status']); retry = h['x-should-retry'] ?? null; });
      req.on('data', (c) => { body += c; });
      req.end('{"model":"claude-opus-4-1","messages":[{"role":"user","content":"hi"}]}');
      await once(req, 'close');
      return { status, retry, body };
    } finally {
      client.close();
      sock.destroy();
    }
  };
  try {
    const ok = await viaTunnel(W1);
    assert.equal(ok.status, 200);
    assert.equal(witness.requests.length, 1);
    assert.equal(witness.requests[0]['x-teamclaude-worker-id'], undefined, 'the header reached upstream through the tunnel');

    const bad = await viaTunnel(BAD);
    assert.equal(bad.status, 400, 'the MITM request listener answers the malformed header');
    assert.equal(bad.retry, 'false');
    assert.equal(JSON.parse(bad.body)?.error?.type, 'invalid_request_error');
    assert.equal(witness.requests.length, 1, 'the malformed request never reached upstream');
  } finally {
    closeHard(mitm);
    closeHard(witness.server);
  }
});

test('a WebSocket upgrade inside the tunnel is strip-only and strips (h1 MITM)', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const witness = makeWitness();
  const upPort = await listen(witness.server);
  const am = new AccountManager([oauth('qa')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }] },
    upstream: `http://127.0.0.1:${upPort}`,
    mitm: { http1Only: true },
  };
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} }));
  const mitmPort = await listen(mitm);

  const sock = await connectThroughProxy(mitmPort, `127.0.0.1:${upPort}`, caCertPem, basic(':ana-key'), ['http/1.1']);
  try {
    sock.write(
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${upPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `x-teamclaude-worker-id: ${BAD}\r\n\r\n`,
    );
    const [reply] = await once(sock, 'data');
    assert.match(reply.toString('utf8').split('\r\n')[0], /101 Switching Protocols/);
    assert.equal(witness.upgrades.length, 1);
    assert.equal(witness.upgrades[0]['x-teamclaude-worker-id'], undefined, 'the header reached the upgrade target');
  } finally {
    sock.destroy();
    closeHard(mitm);
    closeHard(witness.server);
  }
});
