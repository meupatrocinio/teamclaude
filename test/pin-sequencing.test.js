import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { SessionTracker, SESSION_KNOWN_TTL_MS } from '../src/session-tracker.js';
import { createProxyServer } from '../src/server.js';
import { conversationDigest, pinKeyFor } from '../src/conversation.js';

// AI-1960: per-(pin, weekly bucket) latest-started sequencing. A completion
// request that reaches routing is allocated one sequence at admission
// (beginSession), keeps it across retries and hops, and only the LATEST
// sequence for a (record, bucket) may write the pin — a stale request that
// finishes late can no longer restore its destination. count_tokens and
// pre-routing refusals never allocate and never pin (E12); the bucket is fixed
// on the ctx at admission and never recomputed mid-request (E21).

const T = { timeout: 30000 };
const HOUR = 3600_000;
const OPUS = 'claude-opus-4-1';
const BUCKET = 'unified7d';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

// ── tracker/manager semantics ───────────────────────────────────────────────

test('the latest started request owns the pin; a stale write is dropped (AC9)', () => {
  const am = new AccountManager([oauth('qa'), oauth('qb')], 0.98);
  // Request A starts, routes to account 0 (its pin write stands while latest).
  const seqA = am.beginSession('p', null, BUCKET);
  am.recordSession('p', 0, OPUS, { bucket: BUCKET, seq: seqA });
  assert.equal(am.sessionTracker.pinnedAccount('p', BUCKET), 0);
  // Request B starts later on the same pin+bucket and moves the pin.
  const seqB = am.beginSession('p', null, BUCKET);
  assert.ok(seqB > seqA);
  am.recordSession('p', 1, OPUS, { bucket: BUCKET, seq: seqB });
  assert.equal(am.sessionTracker.pinnedAccount('p', BUCKET), 1);
  // A finishes its routing work late: its retry/hop write is dropped.
  am.recordSession('p', 0, OPUS, { bucket: BUCKET, seq: seqA });
  assert.equal(am.sessionTracker.pinnedAccount('p', BUCKET), 1, 'A cannot restore its destination');
  // B's own retries and hops keep its sequence and still write.
  am.recordSession('p', 0, OPUS, { bucket: BUCKET, seq: seqB });
  assert.equal(am.sessionTracker.pinnedAccount('p', BUCKET), 0, 'the latest request writes on every attempt');
  am.endSession('p');
  am.endSession('p');
});

test('sequencing is per bucket: another family neither blocks nor is blocked', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('p', clock.t);
  const seqA = st.allocatePinSeq('p', 'unified7d', clock.t);
  st.beginRequest('p', clock.t);
  const seqB = st.allocatePinSeq('p', 'unified7dFable', clock.t);
  // B is newer but sequenced on a DIFFERENT bucket: A still owns unified7d.
  st.touch('p', 0, 'unified7d', clock.t, seqA);
  st.touch('p', 1, 'unified7dFable', clock.t, seqB);
  assert.equal(st.pinnedAccount('p', 'unified7d', clock.t), 0);
  assert.equal(st.pinnedAccount('p', 'unified7dFable', clock.t), 1);
  // And A's late write on its own bucket still lands: nobody newer started there.
  st.touch('p', 2, 'unified7d', clock.t, seqA);
  assert.equal(st.pinnedAccount('p', 'unified7d', clock.t), 2);
  st.endRequest('p', clock.t);
  st.endRequest('p', clock.t);
});

test('a request without a sequence never writes a pin; a legacy caller always does (E12)', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  // count_tokens shape: routed, but allocated nothing.
  st.touch('ct', 0, BUCKET, clock.t, null);
  assert.equal(st.pinnedAccount('ct', BUCKET, clock.t), null, 'seq null records the visit, not the pin');
  assert.equal(st.sessions.get('ct').latestSeq.size, 0);
  // Legacy direct callers (seq undefined) keep the unsequenced write.
  st.touch('legacy', 1, BUCKET, clock.t);
  assert.equal(st.pinnedAccount('legacy', BUCKET, clock.t), 1);
});

test('sequence state dies with the idle session; in-flight records are never evicted', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('p', clock.t);
  const seq = st.allocatePinSeq('p', BUCKET, clock.t);
  st.touch('p', 0, BUCKET, clock.t, seq);
  // Past the idle TTL with a request still in flight: the record — and its
  // sequencing state — survives the sweep.
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.sweep(clock.t);
  assert.ok(st.sessions.has('p'), 'in flight: never evicted, sequence state retained');
  assert.equal(st.sessions.get('p').latestSeq.get(BUCKET), seq);
  // Once idle past the TTL the record goes, and with it the sequence.
  st.endRequest('p', clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.sweep(clock.t);
  assert.ok(!st.sessions.has('p'));
  // A fresh admission of the same pin starts a clean sequence line.
  st.beginRequest('p', clock.t);
  const seq2 = st.allocatePinSeq('p', BUCKET, clock.t);
  st.touch('p', 1, BUCKET, clock.t, seq2);
  assert.equal(st.pinnedAccount('p', BUCKET, clock.t), 1);
  st.endRequest('p', clock.t);
});

test('recordSession takes the admission-fixed bucket rather than recomputing (E21)', () => {
  const am = new AccountManager([oauth('qa')], 0.98, { routes: [{ name: 'r', match: ['claude-*'], bucket: 'bucketA' }] });
  const seq = am.beginSession('s', null, 'bucketA');
  // A reload lands mid-request: the route table now governs a different bucket.
  am.setRoutes([{ name: 'r', match: ['claude-*'], bucket: 'bucketB' }]);
  am.recordSession('s', 0, OPUS, { bucket: 'bucketA', seq });
  assert.equal(am.sessionTracker.pinnedAccount('s', 'bucketA'), 0, 'the pin lands on the admission bucket');
  assert.equal(am.sessionTracker.pinnedAccount('s', 'bucketB'), null, 'not on the post-reload bucket');
  am.endSession('s');
});

// ── through the gateway ─────────────────────────────────────────────────────

async function withGateway({ handler, routes, blockedModels } = {}, fn) {
  const hits = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    hits.push(req.url);
    if (handler) return handler(req, res, hits.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa')], 0.98, {
    routes,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = { proxy: { apiKey: 'admin-key' }, upstream: `http://127.0.0.1:${upPort}`, blockedModels };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  const send = async (path, { session = 's-seq', text = 'hello' } = {}) => {
    const body = JSON.stringify({ model: OPUS, messages: [{ role: 'user', content: text }] });
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'admin-key', 'x-claude-code-session-id': session },
      body,
    });
    await res.text();
    return { status: res.status, pin: pinKeyFor(session, conversationDigest(Buffer.from(body))) };
  };
  try {
    await fn({ send, hits, am });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('E12: a completion allocates and pins; count_tokens allocates nothing and never pins', T, async () => {
  await withGateway({}, async ({ send, am }) => {
    const comp = await send('/v1/messages', { session: 's-comp', text: 'real' });
    assert.equal(comp.status, 200);
    const rec = am.sessionTracker.sessions.get(comp.pin);
    assert.ok(rec, 'the completion opened a record');
    assert.equal(rec.pins.get(BUCKET)?.idx, 0, 'and pinned it');
    assert.ok(rec.latestSeq.get(BUCKET) > 0, 'with a sequence allocated at admission');

    const ct = await send('/v1/messages/count_tokens', { session: 's-ct', text: 'sizing' });
    assert.equal(ct.status, 200);
    const ctRec = am.sessionTracker.sessions.get(ct.pin);
    // The visit may be recorded (beginSession still holds the request in
    // flight), but nothing was allocated and no pin was written.
    assert.equal(ctRec?.latestSeq.size ?? 0, 0, 'count_tokens never allocates a sequence');
    assert.equal(ctRec?.pins.size ?? 0, 0, 'count_tokens never writes a pin');
    assert.equal(am.sessionTracker.pinnedAccount(ct.pin, BUCKET), null);
  });
});

test('E12: a pre-routing refusal never opens sequencing state', T, async () => {
  await withGateway({ blockedModels: [OPUS] }, async ({ send, am, hits }) => {
    const r = await send('/v1/messages', { session: 's-blocked', text: 'nope' });
    assert.equal(r.status, 400, 'the blocked model is refused before routing');
    assert.equal(hits.length, 0, 'nothing reached upstream');
    assert.ok(!am.sessionTracker.sessions.has(r.pin), 'no record — beginSession never ran — so no sequence exists');
  });
});

test('E21: a mid-request route→bucket reload does not re-bucket the pin write', T, async () => {
  // The first attempt is answered with a headerless 429, which the proxy
  // retries once on the same account after a short wait — the route table is
  // flipped in between, so the retry's recordSession proves which bucket the
  // request kept.
  let flipped = false;
  await withGateway({
    routes: [{ name: 'r', match: ['claude-*'], bucket: 'bucketA' }],
    handler: (_req, res, n) => {
      if (n === 1) {
        flipped = true;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"rate_limit_error","message":"transient"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
    },
  }, async ({ send, am }) => {
    const pending = send('/v1/messages', { session: 's-e21', text: 'bucketed' });
    // Wait for the first attempt to land, then flip the mapping mid-request.
    for (let i = 0; i < 200 && !flipped; i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(flipped, 'the first attempt ran');
    am.setRoutes([{ name: 'r', match: ['claude-*'], bucket: 'bucketB' }]);
    const r = await pending;
    assert.equal(r.status, 200, 'the headerless-429 retry served the request');
    const rec = am.sessionTracker.sessions.get(r.pin);
    assert.ok(rec, 'the request opened a record');
    assert.equal(rec.pins.get('bucketA')?.idx, 0, 'the pin is under the admission bucket');
    assert.equal(rec.pins.has('bucketB'), false, 'never recomputed onto the post-reload bucket');
  });
});
