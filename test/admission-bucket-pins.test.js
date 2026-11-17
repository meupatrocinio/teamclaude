import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, forwardRequest } from '../src/server.js';
import { providerForPath } from '../src/provider.js';
import { conversationDigest, pinKeyFor } from '../src/conversation.js';

// AI-2012: the request-driven pin reads (getActiveAccount's walk and
// observedGeneration) use the weekly bucket the request was ADMITTED under
// (ctx.bucket, AI-1960 E21), not the live route mapping. A reload between
// admission and a re-selecting retry must not move the request onto another
// bucket's pin. Callers that pass no bucket keep the live mapping.

const T = { timeout: 30000 };
const HOUR = 3600_000;
const OPUS = 'claude-opus-4-1';
const ROUTES_A = [{ name: 'r', match: ['claude-*'], bucket: 'bucketA' }];
const ROUTES_B = [{ name: 'r', match: ['claude-*'], bucket: 'bucketB' }];
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
// The access token is derived from the refresh token, so a forced refresh
// hands the account back the token it already had: the 401 retry is served by
// whichever account selection picks, and the upstream can tell which by bearer.
const tokenFor = (refreshToken) => `t-${refreshToken.slice(2)}`;
const oauth = (name) => ({ name, type: 'oauth', accessToken: tokenFor(`r-${name}`), refreshToken: `r-${name}`, expiresAt: Date.now() + HOUR });

// Pinned bucketA→qb (idx 1) and, more recently, bucketB→qa (idx 0). Two pins,
// because with only a bucketA pin a live read still finds qb through the
// bucket-agnostic pinnedAccounts fallback.
function seed(am, pin) {
  am.sessionTracker.touch(pin, 1, 'bucketA', Date.now() - 2000);
  am.sessionTracker.touch(pin, 0, 'bucketB', Date.now() - 1000);
}

async function withGateway({ flip }, fn) {
  /** @type {string[]} */
  const served = [];
  let am;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    served.push(bearer === tokenFor('r-qa') ? 'qa' : bearer === tokenFor('r-qb') ? 'qb' : `?${bearer}`);
    if (served.length === 1) {
      // A reload lands while attempt 1 is upstream: synchronously, before the
      // proxy sees this attempt's answer, so the retry re-selects after it.
      if (flip) am.setRoutes(ROUTES_B);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"token rejected"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upPort = await listen(upstream);
  am = new AccountManager([oauth('qa'), oauth('qb')], 0.98, {
    routes: ROUTES_A,
    distributeSessions: true,
    refreshFn: async (refreshToken) => ({ accessToken: tokenFor(refreshToken), refreshToken, expiresAt: Date.now() + HOUR }),
  });
  const config = { proxy: { apiKey: 'admin-key' }, upstream: `http://127.0.0.1:${upPort}` };
  const proxy = createProxyServer(am, config);
  try {
    const port = await listen(proxy);
    const session = 's-ai2012';
    const body = JSON.stringify({ model: OPUS, messages: [{ role: 'user', content: 'admission bucket' }] });
    const pin = pinKeyFor(session, conversationDigest(Buffer.from(body)));
    seed(am, pin);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'admin-key', 'x-claude-code-session-id': session },
      body,
    });
    await res.text();
    await fn({ status: res.status, served, pins: am.sessionTracker.sessions.get(pin)?.pins });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('a reload between admission and a re-selecting retry keeps the admission bucket pin', T, async () => {
  await withGateway({ flip: true }, async ({ status, served, pins }) => {
    assert.equal(status, 200, 'the 401 refresh retry served the request');
    assert.deepEqual(served, ['qb', 'qb'], 'the retry re-selected the bucketA pin, not the post-reload bucketB pin');
    assert.equal(pins.get('bucketA')?.idx, 1, 'the pin write stays on the admission bucket');
    assert.equal(pins.get('bucketB')?.idx, 0, 'the post-reload bucket pin is untouched');
  });
});

test('control: with no reload both attempts go to the bucketA pin', T, async () => {
  await withGateway({ flip: false }, async ({ status, served, pins }) => {
    assert.equal(status, 200);
    assert.deepEqual(served, ['qb', 'qb']);
    assert.equal(pins.get('bucketA')?.idx, 1);
    assert.equal(pins.get('bucketB')?.idx, 0);
  });
});

test('a caller that passes no bucket reads the live mapping; a passed bucket is honoured', () => {
  const am = new AccountManager([oauth('qa'), oauth('qb')], 0.98, {
    routes: ROUTES_A,
    distributeSessions: true,
    expiryRouting: { enabled: true },
  });
  const P = 'p-ai2012';
  seed(am, P);
  am.setRoutes(ROUTES_B);

  assert.equal(am.getActiveAccount(null, OPUS, null, P)?.index, 0, 'no bucket: the live bucketB pin');
  assert.equal(am.observedGeneration(P, OPUS)?.bucket, 'bucketB', 'no bucket: observed under the live mapping');

  assert.equal(am.getActiveAccount(null, OPUS, null, P, undefined, null, 'bucketA')?.index, 1, 'admission bucket: its own pin');
  assert.equal(am.observedGeneration(P, OPUS, 'bucketA')?.bucket, 'bucketA', 'admission bucket: observed under it');

  // Each walk's _restOnPin stamped the observation of the bucket it read, each
  // move taking a fresh generation, so the two are told apart by gen.
  const genA = am.sessionTracker.refsFor(P, 'bucketA')?.gen;
  const genB = am.sessionTracker.refsFor(P, 'bucketB')?.gen;
  assert.equal(typeof genA, 'number', 'the admission-bucket walk stamped the bucketA observation');
  assert.equal(typeof genB, 'number', 'the live walk stamped the bucketB observation');
  assert.notEqual(genA, genB);
  assert.equal(am.observedGeneration(P, OPUS, 'bucketA')?.pin, genA, 'admission bucket: the bucketA observation is read');
  assert.equal(am.observedGeneration(P, OPUS)?.pin, genB, 'no bucket: the live bucketB observation is read');
});

test('a draining session keeps its admission-bucket pin across a reload', () => {
  const am = new AccountManager([oauth('qa'), oauth('qb')], 0.98, { routes: ROUTES_A, distributeSessions: true });
  const P = 'p-ai2012-drain';
  seed(am, P);
  // Distribution turned off: the sessions pinned at the flip drain on their accounts.
  am.setDistributeSessions(false);
  assert.ok(am._isDrainingSession(P), 'the seeded session is draining');
  am.setRoutes(ROUTES_B);

  assert.equal(am.getActiveAccount(null, OPUS, null, P, undefined, null, 'bucketA')?.index, 1, 'admission bucket: its own pin');
  assert.equal(am.getActiveAccount(null, OPUS, null, P)?.index, 0, 'no bucket: the live bucketB pin');
});

test('a rollover is read from the admission-bucket pin observation after a reload', () => {
  const am = new AccountManager([oauth('qa'), oauth('qb')], 0.98, {
    routes: ROUTES_A,
    distributeSessions: true,
    expiryRouting: { enabled: true, preempt: true },
  });
  for (const a of am.accounts) {
    a.quota.unified7d = 0.4;
    a.quota.unified7dReset = Date.now() + 10 * HOUR;
    a.probing = false;
  }
  const P = 'p-ai2012-roll';
  // Only the bucketA pin: no bucketB observation exists, so a rollover check
  // made under the live bucket after the reload finds nothing and holds.
  am.sessionTracker.touch(P, 1, 'bucketA', Date.now() - 1000);
  assert.equal(am.getActiveAccount(null, OPUS, null, P, undefined, null, 'bucketA')?.index, 1, 'traffic rests on the pin');
  assert.equal(am.sessionTracker.refsFor(P, 'bucketA')?.idx, 1, 'the bucketA observation names the pin');
  // A real weekly roll on the pinned account (as test/expiry-rollover.test.js rolls one).
  am.accounts[1].quota.unified7dReset += 7 * 24 * HOUR;
  am.setRoutes(ROUTES_B);

  const next = am.getActiveAccount(null, OPUS, null, P, undefined, null, 'bucketA');
  assert.equal(next?.index, 0, 'the roll on the bucketA observation released the pin');
});

// Matrix row "external ctx without bucket": forwardRequest driven with a ctx
// built outside the admission listener. With no `bucket` on it the pin reads
// take the live mapping, as before AI-2012; with one, they take that bucket.
async function forwardOnce(ctxBucket, { expiryRouting } = {}) {
  /** @type {string[]} */
  const served = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    served.push(bearer === tokenFor('r-qa') ? 'qa' : bearer === tokenFor('r-qb') ? 'qb' : `?${bearer}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb')], 0.98, { routes: ROUTES_A, distributeSessions: true, expiryRouting });
  // What forwardRequest's pre-walk observedGeneration returned, per attempt.
  const observed = [];
  const observe = am.observedGeneration.bind(am);
  am.observedGeneration = (...args) => {
    const r = observe(...args);
    observed.push(r);
    return r;
  };
  const P = 'p-ai2012-external';
  seed(am, P);
  am.setRoutes(ROUTES_B);
  const body = JSON.stringify({ model: OPUS, messages: [{ role: 'user', content: 'external ctx' }] });
  const host = http.createServer(async (req, res) => {
    const ctx = {
      account: null, status: null, tried: new Set(), reauthed: new Set(),
      model: OPUS, advisorModel: null, pinnedIndex: null, pinKey: P,
      provider: providerForPath(req.url), holdBudgetMs: 0, sessionId: null, client: null,
      delivered: false, abandoned: false, onUsage: () => {}, stripHeaders: null, logLevel: 'off',
      ...(ctxBucket ? { bucket: ctxBucket } : {}),
    };
    await forwardRequest(req, res, Buffer.from(body), am, `http://127.0.0.1:${upPort}`, 0, {}, 'req-1', ctx, null, null, undefined);
    if (!res.writableEnded) res.end();
  });
  const hostPort = await listen(host);
  try {
    const res = await fetch(`http://127.0.0.1:${hostPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await res.text();
    return { status: res.status, served, observed };
  } finally {
    host.closeAllConnections?.(); host.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('forwardRequest with a ctx that carries no bucket reads the live mapping', T, async () => {
  const live = await forwardOnce(null);
  assert.equal(live.status, 200);
  assert.deepEqual(live.served, ['qa'], 'no ctx.bucket: the live bucketB pin, as before AI-2012');
  const admitted = await forwardOnce('bucketA');
  assert.equal(admitted.status, 200);
  assert.deepEqual(admitted.served, ['qb'], 'ctx.bucket set: the admission bucketA pin');
});

test('forwardRequest stamps the resting observation under ctx.bucket', T, async () => {
  const on = { enabled: true, preempt: true };
  const admitted = await forwardOnce('bucketA', { expiryRouting: on });
  assert.equal(admitted.status, 200);
  assert.deepEqual(admitted.served, ['qb']);
  assert.equal(admitted.observed.length, 1);
  assert.equal(admitted.observed[0]?.bucket, 'bucketA', 'ctx.bucket set: observed under the admission bucket');
  const live = await forwardOnce(null, { expiryRouting: on });
  assert.equal(live.observed[0]?.bucket, 'bucketB', 'no ctx.bucket: observed under the live mapping');
});
