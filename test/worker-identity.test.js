import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { keyHashOf } from '../src/client-routes.js';
import { conversationDigest, pinKeyFor, workerScopedPinKey } from '../src/conversation.js';

// AI-1960 (contract W2): opt-in worker identity on the buffered forward path.
// A valid `x-teamclaude-worker-id: w1_<32 lowercase hex>` under a client key
// scopes the pin/offer state to the worker; a malformed one is a non-unified
// 400 before any upstream I/O; the header never reaches upstream; no header is
// the legacy pin, byte-exact.

const T = { timeout: 30000 };
const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key' };
const W1 = 'w1_' + '1'.repeat(32);
const W2 = 'w1_' + '2'.repeat(32);
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });

async function withGateway({ handler, extraConfig } = {}, fn) {
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    attempts.push({ headers: req.headers });
    if (handler) return handler(req, res, Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(okBody);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb')], 0.98, {
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })) },
    upstream: `http://127.0.0.1:${upPort}`,
    ...extraConfig,
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  const send = async ({ key = KEYS.amy, session = 's-1', text = 'hello', worker, path = '/v1/messages', body: rawBody } = {}) => {
    const body = rawBody ?? JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: text }] });
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        ...(session === null ? {} : { 'x-claude-code-session-id': session }),
        ...(worker === undefined ? {} : { 'x-teamclaude-worker-id': worker }),
      },
      body,
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON stays raw */ }
    return { status: res.status, headers: res.headers, raw, json, body };
  };
  // The legacy pin key a request lands on without worker scoping.
  const legacyPin = (session, text) => pinKeyFor(session, conversationDigest(Buffer.from(JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: text }] }))));
  const scopedPin = (key, worker, legacy) => workerScopedPinKey(keyHashOf(key), worker, legacy);
  try {
    await fn({ send, attempts, am, legacyPin, scopedPin });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

// ── the derivation itself ────────────────────────────────────────────────────

test('workerScopedPinKey: exact W2 shape, byte-compatible absence', () => {
  const kh = keyHashOf('amy-key');
  const scoped = workerScopedPinKey(kh, W1, 'sess/conv');
  assert.match(scoped, /^w:[a-f0-9]{32}\x00sess\/conv$/);
  assert.ok(!scoped.includes(kh), 'the keyHash never enters the key (E14)');
  assert.ok(!scoped.includes(W1), 'the worker id never enters the key (E14)');
  // A different worker or key is a different scope; absence is byte-exact legacy.
  assert.notEqual(workerScopedPinKey(kh, W2, 'sess/conv'), scoped);
  assert.notEqual(workerScopedPinKey(keyHashOf('ben-key'), W1, 'sess/conv'), scoped);
  assert.equal(workerScopedPinKey(kh, null, 'sess/conv'), 'sess/conv');
  assert.equal(workerScopedPinKey(null, W1, 'sess/conv'), 'sess/conv');
  assert.equal(workerScopedPinKey(kh, W1, null), null, 'no legacy pin, no invented pin');
});

// ── validation (base stack) ─────────────────────────────────────────────────

test('a malformed worker id is a non-unified 400 before any upstream I/O', T, async () => {
  await withGateway({}, async ({ send, attempts }) => {
    const bad = [
      'w2_' + '1'.repeat(32),            // wrong prefix
      'w1_' + 'A'.repeat(32),            // uppercase
      'w1_' + '1'.repeat(31),            // short
      'w1_' + '1'.repeat(33),            // long
      'w1_' + 'g'.repeat(32),            // non-hex
      '',                                // empty
      'w1_',                             // bare prefix
    ];
    for (const worker of bad) {
      const r = await send({ worker, session: 's-bad', text: 'bad' });
      assert.equal(r.status, 400, `value ${JSON.stringify(worker)}`);
      assert.equal(r.headers.get('x-should-retry'), 'false');
      assert.equal(r.json?.error?.type, 'invalid_request_error');
      // The answer is the static refusal text: the client-supplied value is
      // never echoed back (it would be attacker-controlled bytes in a log or a
      // client display).
      assert.equal(r.json?.error?.message, 'Invalid x-teamclaude-worker-id header: expected "w1_" followed by 32 lowercase hex characters');
    }
    assert.equal(attempts.length, 0, 'the upstream witness recorded nothing');
  });
});

// ── scoping and stripping ───────────────────────────────────────────────────

test('a valid header scopes the pin and never reaches upstream', T, async () => {
  await withGateway({}, async ({ send, attempts, am, legacyPin, scopedPin }) => {
    const r = await send({ worker: W1, session: 's-w', text: 'scoped' });
    assert.equal(r.status, 200);
    const legacy = legacyPin('s-w', 'scoped');
    const scoped = scopedPin(KEYS.amy, W1, legacy);
    assert.ok(am.sessionTracker.sessions.has(scoped), 'the record lives under the scoped key');
    assert.ok(!am.sessionTracker.sessions.has(legacy), 'no legacy record was created');
    assert.ok(am.sessionTracker.sessions.get(scoped).pins.size > 0, 'the scoped record is pinned');
    for (const a of attempts) {
      assert.equal(a.headers['x-teamclaude-worker-id'], undefined, 'the header reached upstream');
    }
  });
});

test('no header: the legacy pin, byte-exact', T, async () => {
  await withGateway({}, async ({ send, am, legacyPin }) => {
    assert.equal((await send({ session: 's-legacy', text: 'plain' })).status, 200);
    const legacy = legacyPin('s-legacy', 'plain');
    assert.ok(am.sessionTracker.sessions.has(legacy), 'the record lives under the legacy key');
    for (const key of am.sessionTracker.sessions.keys()) {
      assert.ok(!key.startsWith('w:'), 'no worker-scoped key without the header');
    }
  });
});

test('two workers on one key and session are fully isolated', T, async () => {
  await withGateway({}, async ({ send, am, legacyPin, scopedPin }) => {
    const legacy = legacyPin('s-iso', 'same opening');
    const pinA = scopedPin(KEYS.amy, W1, legacy);
    const pinB = scopedPin(KEYS.amy, W2, legacy);
    assert.notEqual(pinA, pinB);
    assert.equal((await send({ worker: W1, session: 's-iso', text: 'same opening' })).status, 200);
    assert.equal((await send({ worker: W2, session: 's-iso', text: 'same opening' })).status, 200);
    assert.ok(am.sessionTracker.sessions.has(pinA) && am.sessionTracker.sessions.has(pinB));
    assert.ok(!am.sessionTracker.sessions.has(legacy));
    // An offer recorded for worker A is invisible to worker B's record.
    const offer = { client: 'amy', route: 'seat', bucket: 'unified7d', idx: 0, at: Date.now(), resetsAt: Date.now() + HOUR };
    assert.equal(am.sessionTracker.recordSeatContinuation(pinA, offer), true);
    assert.equal(am.sessionTracker.takeSeatContinuation(pinB, offer), null, 'B has no offer to take');
    assert.ok(am.sessionTracker.takeSeatContinuation(pinA, offer), 'A takes its own');
    // A pin move under one worker never touches the other.
    const before = am.sessionTracker.sessions.get(pinB).pins.get('unified7d')?.idx;
    am.sessionTracker.touch(pinA, before === 0 ? 1 : 0, 'unified7d');
    assert.equal(am.sessionTracker.sessions.get(pinB).pins.get('unified7d')?.idx, before);
  });
});

test('the same wire worker id under two client keys is fully isolated', T, async () => {
  await withGateway({}, async ({ send, am, legacyPin, scopedPin }) => {
    const legacy = legacyPin('s-cross', 'same opening');
    const pinAmy = scopedPin(KEYS.amy, W1, legacy);
    const pinBen = scopedPin(KEYS.ben, W1, legacy);
    assert.notEqual(pinAmy, pinBen, 'the keyHash inside the hash separates the scopes');
    assert.equal((await send({ key: KEYS.amy, worker: W1, session: 's-cross', text: 'same opening' })).status, 200);
    assert.equal((await send({ key: KEYS.ben, worker: W1, session: 's-cross', text: 'same opening' })).status, 200);
    assert.ok(am.sessionTracker.sessions.has(pinAmy) && am.sessionTracker.sessions.has(pinBen));
    for (const key of am.sessionTracker.sessions.keys()) {
      assert.ok(!key.includes(keyHashOf(KEYS.amy)) && !key.includes(keyHashOf(KEYS.ben)), 'no raw keyHash in a tracker key');
      assert.ok(!key.includes(W1), 'no worker id in a tracker key');
    }
  });
});

test('a valid header under the admin key is stripped but scopes nothing (Decision 4)', T, async () => {
  await withGateway({}, async ({ send, attempts, am, legacyPin }) => {
    const r = await send({ key: ADMIN, worker: W1, session: 's-admin', text: 'op' });
    assert.equal(r.status, 200);
    assert.ok(am.sessionTracker.sessions.has(legacyPin('s-admin', 'op')), 'legacy pin: no keyHash to derive against');
    for (const key of am.sessionTracker.sessions.keys()) assert.ok(!key.startsWith('w:'));
    for (const a of attempts) assert.equal(a.headers['x-teamclaude-worker-id'], undefined);
  });
});

test('a thread continue stays on the worker-scoped record (scoped onMessage wiring)', T, async () => {
  // A continue's body carries only the turn's delta, so its conversation is
  // found through the message id the create recorded. That record must be the
  // SCOPED one — recorded under the legacy key it would be invisible to the
  // scoped lookup (or worse, shared across workers).
  await withGateway({ extraConfig: { messageThreads: true } }, async ({ send, am, legacyPin, scopedPin }) => {
    const legacy = legacyPin('s-thread', 'opening');
    const scoped = scopedPin(KEYS.amy, W1, legacy);
    const create = JSON.stringify({
      model: 'claude-opus-4-1',
      messages: [{ role: 'user', content: 'opening' }],
      thread: { type: 'create' },
    });
    const r1 = await send({ worker: W1, session: 's-thread', body: create });
    assert.equal(r1.status, 200);
    assert.ok(am.sessionTracker.sessions.get(scoped)?.threads.has('msg_1'), 'the message id was filed under the scoped record');
    assert.ok(!am.sessionTracker.sessions.has(legacy), 'nothing was filed under the legacy key');

    const cont = JSON.stringify({
      model: 'claude-opus-4-1',
      messages: [{ role: 'user', content: 'delta only' }],
      thread: { type: 'continue', previous_message_id: 'msg_1' },
    });
    const r2 = await send({ worker: W1, session: 's-thread', body: cont });
    assert.equal(r2.status, 200, 'the continue resolved its conversation through the scoped record');
    const rec = am.sessionTracker.sessions.get(scoped);
    assert.equal(rec?.count, 2, 'both turns landed on the worker-scoped record');
    assert.ok(!am.sessionTracker.sessions.has(legacy), 'the continue never touched the legacy key');
    // The continue followed the create's pin rather than re-routing.
    assert.equal(rec.pins.get('unified7d')?.idx, 0);
  });
});

test('a request with no session id scopes nothing and invents no pin', T, async () => {
  await withGateway({}, async ({ send, attempts, am }) => {
    const r = await send({ worker: W1, session: null, text: 'no session' });
    assert.equal(r.status, 200, 'the request is still served');
    assert.equal(am.sessionTracker.sessions.size, 0, 'no session record, scoped or legacy, was invented');
    assert.equal(am.sessionTracker.workerScopeCounts().workers, 0, 'no worker scope was admitted without a pin to scope');
    for (const a of attempts) assert.equal(a.headers['x-teamclaude-worker-id'], undefined);
  });
});
