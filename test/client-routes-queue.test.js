import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The seat queue (IPM fork): a multi-account seat is a drain queue in config
// order, and a conversation pins to the first account it started on. The pin
// beats the queue: a conversation whose account spends out is hard-stopped
// with the queue's next account named and the handoff recommended — never
// silently moved onto it, which would re-process the whole conversation with
// a cold cache. Only a FRESH conversation (no pin, e.g. after a handoff)
// advances the queue. Quota is spent one account at a time, not spread.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));

const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key' };
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

// amy → seat-q (accounts qa then qb, the queue order); ben → seat-r (qr).
const ROUTES = [
  { name: 'seat-q', clients: ['amy'], accounts: ['qa', 'qb'] },
  { name: 'seat-r', clients: ['ben'], accounts: ['qr'] },
];

const ok = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
};

// qa spent: a 429 whose unified headers reject the weekly window.
const spent = (res) => {
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
  });
  res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
};

async function withGateway({ handler = (_who, res) => ok(res) } = {}, fn) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    handler(who, res);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb'), oauth('qr')], 0.98, {
    clientRoutes: ROUTES,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  // One turn of one conversation: the body identifies the conversation, so
  // `text` distinguishes conversations under one session id.
  const send = async ({ key = KEYS.amy, session = 's-1', text = 'hello' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-claude-code-session-id': session },
      body: JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: text }] }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ send, seen });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('a conversation on a multi-account seat stays on the queue head across turns', async () => {
  await withGateway({}, async ({ send, seen }) => {
    for (let turn = 0; turn < 5; turn++) {
      // One conversation: same session, same opening, growing transcript.
      assert.equal((await send({ text: 'hello' })).status, 200);
    }
    assert.deepEqual([...new Set(seen)], ['qa'], `the conversation spread: ${JSON.stringify(seen)}`);
  });
});

test('fresh conversations drain the queue head too — quota is not spread across the seat', async () => {
  await withGateway({}, async ({ send, seen }) => {
    for (const text of ['conv one', 'conv two', 'conv three']) {
      assert.equal((await send({ text })).status, 200);
    }
    assert.deepEqual([...new Set(seen)], ['qa'], `fresh conversations spread: ${JSON.stringify(seen)}`);
  });
});

test('when the pinned account spends out: hard stop naming the queue next, sibling untouched', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    // The conversation opens on qa while it serves.
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa']);

    // qa spends out. The next turn of the SAME conversation discovers it
    // upstream and must hard-stop with the queue answer — not move to qb.
    qaSpent = true;
    const stopped = await send({ text: 'hello' });
    assert.equal(stopped.status, 429);
    assert.equal(stopped.json?.error?.type, 'rate_limit_error');
    const msg = stopped.json?.error?.message ?? '';
    assert.ok(msg.includes('out of quota'), msg);
    assert.ok(msg.includes('pinned to "qa"'), msg);
    assert.ok(msg.includes('"qb"'), `the queue next is not named: ${msg}`);
    assert.ok(msg.includes('/ipm:handoff'), `the handoff is not recommended: ${msg}`);
    assert.deepEqual(seen, ['qa', 'qa'], `the request leaked to the sibling: ${JSON.stringify(seen)}`);

    // Retrying the same conversation stops again without even going upstream
    // (the recorded rejection answers), and still never touches qb.
    const again = await send({ text: 'hello' });
    assert.equal(again.status, 429);
    assert.deepEqual(seen, ['qa', 'qa'], `the retry went upstream: ${JSON.stringify(seen)}`);

    // A FRESH conversation — the handoff flow — advances the queue to qb.
    const fresh = await send({ text: 'a new conversation' });
    assert.equal(fresh.status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

test('a single-account seat is unchanged: spent is a hard stop with no queue hint', async () => {
  await withGateway({ handler: (_who, res) => spent(res) }, async ({ send }) => {
    const r = await send({ key: KEYS.ben });
    assert.equal(r.status, 429);
    const msg = r.json?.error?.message ?? '';
    assert.ok(msg.includes('out of quota'), msg);
    assert.ok(!msg.includes('pinned to'), `a single-seat stop must not name a queue: ${msg}`);
  });
});
