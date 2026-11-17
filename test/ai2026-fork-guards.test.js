import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionTracker } from '../src/session-tracker.js';
import { workerScopedPinKey } from '../src/conversation.js';
import { keyHashOf } from '../src/client-routes.js';
import { ClaudeReauthFlows } from '../src/claude-reauth.js';
import { ClaudeResetRedeemer, parseResetStatus, claimableGrant } from '../src/claude-resets.js';

// AI-2026: the upstream v1.1.30 merge keeps every fork feature. Upstream code
// that merged without a conflict re-routes, compacts or re-authenticates in
// ways a fixed seat (clientRoutes) must not see; each guard added for it is
// proved here, one test per guard. Tests 1-3 encode ipm.24 behaviour and were
// also run against the ipm.24 sources.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const ADMIN = 'admin-key';
const KEYS = { ana: 'ana-key', uma: 'uma-key' };
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });

const ok = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
};

// Anthropic's billing refusal: the message upstream's #626 failover keys on.
const BILLING_400 = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
const billing = (res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(BILLING_400); };

/**
 * A proxy over oauth accounts `sa`, `sb` and `sc` against a recorder upstream.
 * `ana` is on a route (seat-a), `uma` has a key and no route.
 * @param {{ handler?: (who: string, req: any, res: any) => void, routes?: any[], proxy?: Record<string, any>, config?: Record<string, any>, accounts?: any[] }} opts
 * @param {(ctx: any) => Promise<void>} fn
 */
async function withGateway({ handler = (_who, _req, res) => ok(res), routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa'] }], proxy = {}, config = {}, accounts } = {}, fn) {
  /** @type {{ who: string, path: string }[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = String(req.headers.authorization || req.headers['x-api-key'] || '').replace(/^Bearer t-/, '');
    seen.push({ who, path: req.url });
    handler(who, req, res);
  });
  const upPort = await listen(upstream);
  const origLog = console.log, origError = console.error;
  console.log = () => {};
  console.error = () => {};
  const am = new AccountManager(accounts ?? [oauth('sa'), oauth('sb'), oauth('sc')], 0.98, { clientRoutes: routes, refreshFn: async () => { throw new Error('no refresh'); } });
  const cfg = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), ...proxy },
    upstream: `http://127.0.0.1:${upPort}`,
    ...config,
  };
  const server = createProxyServer(am, cfg, {});
  const port = await listen(server);
  /** @param {{ key?: string|null, path?: string, method?: string, model?: string, session?: string, body?: string }} [o] */
  const send = async ({ key = null, path = '/v1/messages', method = 'POST', model = 'claude-opus-4-1', session = undefined, body = undefined } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        ...(session ? { 'x-claude-code-session-id': session } : {}),
      },
      body: method === 'GET' ? undefined : (body ?? JSON.stringify({ model, messages: [] })),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  try {
    await fn({ am, seen, send, port });
  } finally {
    console.log = origLog;
    console.error = origError;
    server.closeAllConnections?.(); server.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

// ── (1) control plane ───────────────────────────────────────────────────────

test('(1) under requireClientRoute a seat key\'s control-plane call is served by its seat account', async () => {
  await withGateway({ proxy: { requireClientRoute: true } }, async ({ send, seen }) => {
    const r = await send({ key: KEYS.ana, method: 'GET', path: '/api/claude_cli/bootstrap' });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, [{ who: 'sa', path: '/api/claude_cli/bootstrap' }], 'the seat account\'s token, through the pool and the seat gate');
    // A key with no seat is refused by the seat gate, as for inference.
    const noSeat = await send({ key: KEYS.uma, method: 'GET', path: '/api/claude_cli/bootstrap' });
    assert.equal(noSeat.status, 403);
    assert.equal(seen.length, 1, 'nothing more went upstream');
  });
});

test('(1b) a routed key keeps the pool path without requireClientRoute; an explicit controlPlane is honoured', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.ana, method: 'GET', path: '/api/claude_cli/bootstrap' })).status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa']);
  });
  // A key on no route, nothing required: upstream's default (the client's own login).
  await withGateway({}, async ({ send, seen }) => {
    await send({ key: KEYS.uma, method: 'GET', path: '/api/claude_cli/bootstrap' });
    assert.ok(seen.every(s => !['sa', 'sb', 'sc'].includes(s.who)), `no pooled token: ${JSON.stringify(seen)}`);
  });
  await withGateway({ proxy: { requireClientRoute: true, controlPlane: 'client' } }, async ({ send, seen }) => {
    await send({ key: KEYS.ana, method: 'GET', path: '/api/claude_cli/bootstrap' });
    assert.ok(seen.every(s => !['sa', 'sb', 'sc'].includes(s.who)), `an explicit "client" relays on the caller's login: ${JSON.stringify(seen)}`);
  });
});

// ── (2) list pins under a route ─────────────────────────────────────────────

// API-key accounts: the list walk (advancePinPastBilling) moves between those only.
const apikey = (/** @type {string} */ name) => ({ name, type: 'apikey', apiKey: name });

test('(2) a route-bound key\'s list pin seat,other never reaches other when the seat refuses for billing', async () => {
  await withGateway({ accounts: [apikey('sa'), apikey('sb'), apikey('sc')], handler: (who, _req, res) => (who === 'sa' ? billing(res) : ok(res)) }, async ({ send, seen }) => {
    for (let i = 0; i < 3; i++) {
      const r = await send({ key: KEYS.ana, path: '/tc-acct/sa,sc/v1/messages' });
      assert.notEqual(r.status, 200, 'never served by an account outside the seat');
    }
    assert.ok(seen.every(s => s.who !== 'sc'), `upstream saw ${JSON.stringify(seen)}`);
  });
});

test('(2b) the list pin\'s tail is cleared under a route: the seat\'s own billing 400 is relayed', async () => {
  await withGateway({ accounts: [apikey('sa'), apikey('sb'), apikey('sc')], handler: (who, _req, res) => (who === 'sa' ? billing(res) : ok(res)) }, async ({ send, seen }) => {
    const r = await send({ key: KEYS.ana, path: '/tc-acct/sa,sc/v1/messages' });
    assert.equal(r.status, 400);
    assert.equal(r.text, BILLING_400);
    assert.deepEqual(seen.map(s => s.who), ['sa']);
  });
});

// ── (3) billing failover ────────────────────────────────────────────────────

test('(3) a route-bound seat answering a billing 400 relays it, with no sibling attempt', async () => {
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  await withGateway({ routes, handler: (who, _req, res) => (who === 'sa' ? billing(res) : ok(res)) }, async ({ send, seen }) => {
    const r = await send({ key: KEYS.ana, session: 'sess-billing-1' });
    assert.equal(r.status, 400);
    assert.equal(r.text, BILLING_400);
    assert.deepEqual(seen.map(s => s.who), ['sa'], 'neither the seat sibling nor the fleet is tried');
    const again = await send({ key: KEYS.ana, session: 'sess-billing-1' });
    assert.equal(again.status, 400, 'no billing cooldown moves the next request off the seat either');
    assert.deepEqual(seen.map(s => s.who), ['sa', 'sa']);
  });
});

// ── (4) compactBeforeSwitch ─────────────────────────────────────────────────

test('(4) compactBeforeSwitch never answers its synthetic 400 to a request bound to a seat', async () => {
  const body = (/** @type {number} */ pad) => JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 16, messages: [{ role: 'user', content: 'first task' }, { role: 'assistant', content: 'x'.repeat(pad) }] });
  // Every answer puts the serving account inside the margin of its 5-hour switch threshold.
  const nearThreshold = (/** @type {string} */ _who, /** @type {any} */ _req, /** @type {any} */ res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.95',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 4 * HOUR) / 1000)),
    });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  };
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  const config = { compactBeforeSwitch: { minBodyBytes: 2000 } };
  // Control: the same conversation from a key on no route is asked to
  // compact, so the setup does reach the ask.
  await withGateway({ routes, config, handler: nearThreshold, accounts: [oauth('sa'), oauth('sb')] }, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.uma, session: 'sess-compact', body: body(100) })).status, 200);
    const asked = await send({ key: KEYS.uma, session: 'sess-compact', body: body(8000) });
    assert.equal(asked.status, 400, `the control conversation is asked to compact: ${asked.text}`);
    assert.match(asked.text, /prompt is too long/);
    assert.equal(seen.length, 1);
  });
  await withGateway({ routes, config, handler: nearThreshold, accounts: [oauth('sa'), oauth('sb')] }, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.ana, session: 'sess-compact', body: body(100) })).status, 200);
    for (let i = 0; i < 3; i++) {
      const r = await send({ key: KEYS.ana, session: 'sess-compact', body: body(8000) });
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(seen.length, 4, 'every turn of the bound conversation reached its seat');
    assert.ok(seen.every(s => s.who === 'sa' || s.who === 'sb'));
  });
});

// ── (5) affinity persistence of worker-scoped keys ──────────────────────────

test('(5) a worker-scoped key longer than 151 chars survives the affinity export and restore', () => {
  const legacy = 's'.repeat(128) + '\0' + 'c'.repeat(22);
  const key = workerScopedPinKey(keyHashOf('ana-key'), 'w1_' + 'a'.repeat(32), legacy);
  assert.ok(key.length > 151 && key.length <= 253, `key length ${key.length}`);
  const ids = ['acct-0', 'acct-1'];
  const before = new SessionTracker();
  before.touch(key, 1, 'unified7d');
  before.touch(legacy, 0, 'unified7d');
  const snapshot = JSON.parse(JSON.stringify(before.exportAffinity(i => ({ id: ids[i], provider: 'anthropic' }))));
  assert.ok(snapshot.sessions.some((/** @type {any} */ r) => r.key === key), 'the worker-scoped record is saved');
  const after = new SessionTracker();
  after.restoreAffinity(snapshot, ref => ids.indexOf(ref.id));
  assert.equal(after.pinnedAccount(key, 'unified7d'), 1);
  assert.equal(after.pinnedAccount(legacy, 'unified7d'), 0, 'the legacy record is restored on its own, not collapsed into the worker scope');
});

// ── (6) account-release ─────────────────────────────────────────────────────

test('(6) account-release clears every per-bucket and worker-scoped record on that account', async () => {
  const legacy = 'sess-release-1';
  const scoped = workerScopedPinKey(keyHashOf('ana-key'), 'w1_' + 'b'.repeat(32), legacy);
  await withGateway({ accounts: [oauth('sa'), oauth('sb')] }, async ({ am, port }) => {
    const t = am.sessionTracker;
    t.touch(legacy, 0, 'unified7d');
    t.touch(legacy, 0, 'unified7dFable');
    t.touch(scoped, 0, 'unified7d');
    t.touch('sess-release-other', 1, 'unified7d');
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account-release`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ADMIN }, body: JSON.stringify({ account: 'sa' }),
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.released, 2, 'the legacy conversation and its worker scope');
    assert.equal(t.pinnedAccount(legacy, 'unified7d'), null);
    assert.equal(t.pinnedAccount(legacy, 'unified7dFable'), null);
    assert.equal(t.pinnedAccount(scoped, 'unified7d'), null);
    assert.equal(t.pinnedAccount('sess-release-other', 'unified7d'), 1, 'another account\'s pin stays');
  });
});

// ── (7) reauth of a long-lived account ──────────────────────────────────────

test('(7) reauth start on a longLived account answers 409 long_lived_account and opens no OAuth flow', async () => {
  let started = 0;
  const flows = new ClaudeReauthFlows({ startFlow: async () => { started++; return { url: 'https://example.invalid/oauth' }; } });
  const am = new AccountManager([oauth('ll', { longLived: true, accountUuid: 'u-ll', orgUuid: 'o-ll' })], 0.98);
  const server = createProxyServer(am, { proxy: { apiKey: ADMIN }, upstream: 'http://127.0.0.1:9' }, {
    startClaudeReauth: (/** @type {number} */ index) => flows.start(am.accounts[index]),
  });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/claude-reauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ADMIN },
      body: JSON.stringify({ account: 'll' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, reason: 'long_lived_account' });
    assert.equal(started, 0);
    assert.equal(flows.flows.size, 0);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});

// ── (8) the resets panel's claims are saved and replayed ────────────────────

test('(8) a panel (TUI) claim is saved before its POST, and a lost verdict replays the same request id', async () => {
  const account = oauth('seat', { id: 'entry-seat', accountUuid: 'u-seat', orgUuid: 'o-seat' });
  const am = new AccountManager([account], 0.98);
  am.ensureTokenFresh = async () => {};
  let saved = {};
  const updateStateFn = async (/** @type {(s: any) => void} */ updater) => { const next = JSON.parse(JSON.stringify(saved)); updater(next); saved = next; };
  /** @type {{ requestId: string, grantId: string, savedFirst: any }[]} */
  const claims = [];
  let verdict = { error: 'socket hang up' };
  let clock = Date.now();
  const make = (/** @type {any} */ pending) => new ClaudeResetRedeemer(am, {
    log: () => {}, now: () => clock, updateStateFn, pending,
    statusFn: async () => ({ reset: null }),
    claimFn: async (/** @type {any} */ _a, /** @type {any} */ c) => {
      claims.push({ ...c, savedFirst: saved.claudeResetPending?.['entry-seat'] ?? null });
      return verdict;
    },
  });
  const first = make(null);
  const lost = await first.redeemGrant(am.accounts[0], 'weekly', { manual: true });
  assert.equal(lost.redeemed, false);
  assert.equal(lost.uncertain, true);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].savedFirst?.requestId, claims[0].requestId, 'the intent was on disk before the POST');
  assert.equal(claims[0].savedFirst?.grantId, 'weekly');
  assert.equal(saved.claudeResetPending['entry-seat'].requestId, claims[0].requestId, 'kept after the lost verdict');

  // A restart: the saved claim comes back, and the same grant replays its id.
  clock += 31 * 60_000;
  verdict = { result: 'already_used', resetsLeft: 0, cleared: ['seven_day'] };
  const restarted = make(saved.claudeResetPending);
  const other = await restarted.redeemGrant(am.accounts[0], 'fable', { manual: true });
  assert.equal(other.redeemed, false);
  assert.equal(other.reason, 'pending_replay', 'one unanswered claim per account');
  assert.equal(claims.length, 1);
  const replay = await restarted.redeemGrant(am.accounts[0], 'weekly', { manual: true });
  assert.equal(replay.redeemed, true);
  assert.equal(claims.length, 2);
  assert.equal(claims[1].requestId, claims[0].requestId);
  assert.deepEqual(saved.claudeResetPending, {}, 'cleared with the verdict');
});

// The fork's /teamclaude/claude-reset route spends only upstream's next grant
// (ipm.24's rule, kept beside upstream's usableGrant).
test('claimableGrant: only next_grant_id is claimable, and only while usable', () => {
  const block = (/** @type {any} */ extra = {}, /** @type {any} */ grant = {}) => ({
    eligible: true, at_limit: true, exhausted: ['seven_day'], next_grant_id: 'g1',
    grants: [{ id: 'g1', resets_left: 1, usable_now: true, paused: false, clears: ['seven_day'], ends_at: new Date(Date.now() + HOUR).toISOString(), ...grant }],
    ...extra,
  });
  assert.equal(claimableGrant(parseResetStatus(block()))?.id, 'g1');
  assert.equal(claimableGrant(parseResetStatus(block({ next_grant_id: null }))), null);
  assert.equal(claimableGrant(parseResetStatus(block({ next_grant_id: 'someone-else' }))), null);
  for (const g of [{ paused: true }, { usable_now: false }, { resets_left: 0 }, { ends_at: new Date(Date.now() - HOUR).toISOString() }]) {
    assert.equal(claimableGrant(parseResetStatus(block({}, g))), null, JSON.stringify(g));
  }
  assert.equal(claimableGrant(parseResetStatus(block({ eligible: false }))), null);
});
