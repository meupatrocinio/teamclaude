import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { recordSeatRejection } from '../src/client-routes.js';

// AI-2049: at the end of its pinned account, a `recommend` conversation moves
// to the next account of the seat on its own, in the same request, as `force`
// does. The two policies differ only before the end: `recommend` gets the
// handoff ask, `force` never does. Each scenario records what the client saw:
// the 429s, the request on which it moved with a cold cache, the account that
// served last, and how many requests it sent.

const HOUR = 3600_000;
const listen = (/** @type {http.Server} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(/** @type {any} */ (s.address()).port)));
const sec = (/** @type {number} */ ms) => String(Math.floor(ms / 1000));
const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key' };
const oauth = (/** @type {string} */ name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const ROUTES = [{ name: 's1+s2+s3', clients: ['amy'], accounts: ['qa', 'qb', 'qc'] }];
const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
const LARGE = 210_000;
const SMALL = 1_000;
const WORKER = `w1_${'ab'.repeat(16)}`;
const REJECTED = () => ({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-7d-status': 'rejected',
  'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
});
/** Mark an account spent as the proxy would after upstream rejected it (someone else used it up). @param {any} am @param {number} i */
const markSpent = (am, i) => recordSeatRejection(am.accounts[i], REJECTED(), 'claude-opus-4-1');

/**
 * A gateway on a three-account seat in front of a stub upstream.
 * `state.five[name]` is the 5-hour reading the stub reports; an account in
 * `state.spent` answers a 429 that rejects the weekly window.
 * @param {{ five: Record<string, number> }} opts
 * @param {(h: any) => Promise<void>} fn
 */
async function withGateway({ five }, fn) {
  const state = { five: { ...five }, spent: new Set() };
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await new Promise(r => req.on('end', r));
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    if (state.spent.has(who)) {
      res.writeHead(429, { 'content-type': 'application/json', ...REJECTED() });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      return;
    }
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    if (state.five[who] != null) {
      headers['anthropic-ratelimit-unified-5h-utilization'] = String(state.five[who]);
      headers['anthropic-ratelimit-unified-5h-reset'] = sec(Date.now() + 2 * HOUR);
    }
    res.writeHead(200, headers);
    res.end(okBody);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb'), oauth('qc')], 0.98, {
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
  const origLog = console.log;
  /** @type {string[]} */
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };

  /** @type {{ n: number, status: number, served: string|null, cold: boolean, kind: string, message: string }[]} */
  const trace = [];
  // One request of one conversation.
  const send = async (/** @type {{ pad?: number, worker?: string, policy?: string }} */ { pad = LARGE, worker, policy } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEYS.amy,
        'x-claude-code-session-id': 's-1',
        ...(worker ? { 'x-teamclaude-worker-id': worker } : {}),
        ...(policy ? { 'x-teamclaude-seat-policy': policy } : {}),
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        messages: [{ role: 'user', content: 'first task' }, { role: 'assistant', content: 'x'.repeat(pad) }, { role: 'user', content: 'go on' }],
      }),
    });
    const raw = await res.text();
    const message = (() => { try { return JSON.parse(raw)?.error?.message ?? ''; } catch { return ''; } })();
    const kind = res.status === 200 ? 'ok'
      : /\/ipm:handoff/.test(message) ? 'ask'
        : /next prompt confirms/.test(message) ? 'offer'
          : 'spent';
    const entry = { n: trace.length + 1, status: res.status, served: res.status === 200 ? seen[seen.length - 1] : null, cold: !!res.headers.get('x-teamclaude-seat-failover'), kind, message };
    trace.push(entry);
    return entry;
  };
  // One prompt the person wants answered: re-sent after any 429 (they read it
  // and type again), at most `tries` times.
  const prompt = async (/** @type {any} */ opts = {}, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      const r = await send(opts);
      if (r.status === 200) return r;
    }
    return trace[trace.length - 1];
  };
  try {
    await fn({ prompt, state, am });
  } finally {
    console.log = origLog;
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
  const cold = trace.find(t => t.cold);
  const served = trace.filter(t => t.served);
  return {
    trace,
    requests: trace.length,
    n429: trace.filter(t => t.status === 429).length,
    kinds: trace.filter(t => t.status === 429).map(t => `${t.kind}@${t.n}`).join(',') || '-',
    coldMove: cold ? `yes@${cold.n}` : 'no',
    final: served.length ? served[served.length - 1].served : '(none)',
    asked: am.handoffAsks.asked,
    hops: logs.map(l => /Seat (force|recommend) continuation/.exec(l)?.[1]).filter(Boolean),
  };
}

test('large, asked, then spent: one ask, then a hop with no second interruption', async () => {
  const r = await withGateway({ five: { qa: 0.6 } }, async ({ prompt, state }) => {
    await prompt();                 // pins qa, reads 0.60
    state.five.qa = 0.8;
    await prompt();                 // reads 0.80
    await prompt();                 // asked (429), the re-send goes through warm on qa
    state.spent.add('qa');
    await prompt();                 // qa is spent: continues on qb in the same request
    await prompt();                 // one more turn after, on qb
  });
  assert.equal(r.asked, 1);
  assert.equal(r.kinds, 'ask@3');
  assert.deepEqual([r.n429, r.coldMove, r.requests, r.final], [1, 'yes@5', 6, 'qb']);
  assert.deepEqual(r.hops, ['recommend']);
});

test('small, never asked, then spent: a hop with no 429', async () => {
  const r = await withGateway({ five: { qa: 0.8 } }, async ({ prompt, state }) => {
    await prompt({ pad: SMALL });
    await prompt({ pad: SMALL });
    state.spent.add('qa');
    await prompt({ pad: SMALL });
    await prompt({ pad: SMALL });
  });
  assert.equal(r.asked, 0);
  assert.deepEqual([r.n429, r.coldMove, r.requests, r.final], [0, 'yes@3', 4, 'qb']);
  assert.deepEqual(r.hops, ['recommend']);
});

test('large, jumps from below the threshold to spent (used up by someone else): a hop, never asked', async () => {
  const r = await withGateway({ five: { qa: 0.5 } }, async ({ prompt, state, am }) => {
    await prompt();
    await prompt();
    state.spent.add('qa');
    markSpent(am, 0);
    await prompt();                 // the recorded rejection moves it pre-send
    await prompt();
  });
  assert.equal(r.asked, 0);
  assert.deepEqual([r.n429, r.coldMove, r.requests, r.final], [0, 'yes@3', 4, 'qb']);
  assert.deepEqual(r.hops, ['recommend']);
});

test('a worker, large: never asked, and a hop at the end instead of a 429 nobody reads', async () => {
  const r = await withGateway({ five: { qa: 0.93 } }, async ({ prompt, state }) => {
    await prompt({ worker: WORKER });
    await prompt({ worker: WORKER });
    state.spent.add('qa');
    await prompt({ worker: WORKER });
    await prompt({ worker: WORKER });
  });
  assert.equal(r.asked, 0);
  assert.deepEqual([r.n429, r.coldMove, r.requests, r.final], [0, 'yes@3', 4, 'qb']);
  assert.deepEqual(r.hops, ['recommend']);
});

test('every account on the route spent: no sibling, the same stop as before', async () => {
  const r = await withGateway({ five: { qa: 0.93 } }, async ({ prompt, state, am }) => {
    await prompt();
    await prompt();                 // asked, re-sent warm
    for (const [i, name] of ['qa', 'qb', 'qc'].entries()) { state.spent.add(name); markSpent(am, i); }
    await prompt({}, 2);
  });
  assert.equal(r.asked, 1);
  assert.deepEqual([r.n429, r.coldMove, r.requests, r.final], [3, 'no', 5, 'qa']);
  assert.equal(r.kinds, 'ask@2,spent@4,spent@5');
  for (const t of r.trace.slice(3)) {
    assert.match(t.message, /^Your Claude seat "s1\+s2\+s3" is out of quota until \S+Z\. This conversation is pinned to "qa", and no other account on this seat can serve now\. /);
  }
  assert.deepEqual(r.hops, []);
});

test('force control: never asked, the same hop as before', async () => {
  const r = await withGateway({ five: { qa: 0.93 } }, async ({ prompt, state }) => {
    await prompt({ policy: '*=force' });
    await prompt({ policy: '*=force' });   // force is never asked
    state.spent.add('qa');
    await prompt({ policy: '*=force' });
    await prompt({ policy: '*=force' });
  });
  assert.equal(r.asked, 0);
  assert.deepEqual([r.n429, r.coldMove, r.requests, r.final], [0, 'yes@3', 4, 'qb']);
  assert.deepEqual(r.hops, ['force']);
});
