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
  /** @param {{ key?: string|null, path?: string, method?: string, model?: string, session?: string, body?: string, headers?: Record<string, string> }} [o] */
  const send = async ({ key = null, path = '/v1/messages', method = 'POST', model = 'claude-opus-4-1', session = undefined, body = undefined, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        ...(session ? { 'x-claude-code-session-id': session } : {}),
        ...headers,
      },
      body: method === 'GET' ? undefined : (body ?? JSON.stringify({ model, messages: [] })),
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
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
    assert.equal((await send({ key: KEYS.uma, method: 'GET', path: '/api/claude_cli/bootstrap' })).status, 200);
    assert.ok(seen.length > 0, 'the call reached upstream');
    assert.ok(seen.every(s => !['sa', 'sb', 'sc'].includes(s.who)), `no pooled token: ${JSON.stringify(seen)}`);
  });
  await withGateway({ proxy: { requireClientRoute: true, controlPlane: 'client' } }, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.ana, method: 'GET', path: '/api/claude_cli/bootstrap' })).status, 200);
    assert.ok(seen.length > 0, 'the call reached upstream');
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

// An account refusal (upstream's OAuth account-refusal failover) and a 402
// billing answer (upstream's #626 failover): both leave the seat unmoved.
const REFUSAL_400 = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'This account is on hold.', details: { error_code: 'account_on_hold' } } });
const BILLING_402 = JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Billing is unavailable.' } });
const answer = (/** @type {number} */ status, /** @type {string} */ text) => (/** @type {any} */ res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(text); };

test('(3b) a route-bound seat answering an account-refusal 400 or a 402 relays it; unbound traffic still fails over', async () => {
  for (const [status, text] of /** @type {[number, string][]} */ ([[400, REFUSAL_400], [402, BILLING_402]])) {
    const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
    await withGateway({ routes, handler: (who, _req, res) => (who === 'sa' ? answer(status, text)(res) : ok(res)) }, async ({ send, seen }) => {
      const r = await send({ key: KEYS.ana, session: `sess-seat-${status}` });
      assert.equal(r.status, status, `the seat's ${status} is relayed`);
      assert.equal(r.text, text);
      assert.deepEqual(seen.map(s => s.who), ['sa'], `a ${status} on the seat tries neither the seat sibling nor the fleet`);
    });
    // Control: the same answer from every account moves an unbound request on,
    // so the guard above is what keeps the seat request in place.
    await withGateway({ routes: [], handler: (_who, _req, res) => answer(status, text)(res) }, async ({ send, seen }) => {
      await send({ key: KEYS.uma, session: `sess-fleet-${status}` });
      assert.ok(seen.length > 1, `an unbound ${status} fails over (attempts: ${seen.map(s => s.who).join(',')})`);
    });
  }
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

// ── review follow-ups: one test per remaining guard ─────────────────────────

const SCOPE_403 = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement', details: { error_code: 'oauth_scope_insufficient' } } });

test('(a) a list pin under a route never walks past a seat account another key put in billing cooldown', async () => {
  let refuse = true;
  const handler = (/** @type {string} */ who, /** @type {any} */ _req, /** @type {any} */ res) => (who === 'sa' && refuse ? billing(res) : ok(res));
  await withGateway({ accounts: [apikey('sa'), apikey('sb'), apikey('sc')], handler }, async ({ am, send, seen }) => {
    // An unrouted key draws the billing refusal: sa sits in its billing cooldown.
    await send({ key: KEYS.uma, path: '/tc-acct/sa/v1/messages' });
    assert.equal(am.isBillingRejected(0), true, 'setup: sa is billing-rejected');
    refuse = false;
    seen.length = 0;
    const r = await send({ key: KEYS.ana, path: '/tc-acct/sa,sc/v1/messages' });
    assert.ok(seen.every(s => s.who !== 'sc'), `upstream saw ${JSON.stringify(seen)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa'], 'the seat answers from its own account');
  });
});

test('(b) a seat request is answered by a seat account another key put in billing cooldown, not moved to a sibling', async () => {
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  let refuse = true;
  const handler = (/** @type {string} */ who, /** @type {any} */ _req, /** @type {any} */ res) => (who === 'sa' && refuse ? billing(res) : ok(res));
  await withGateway({ routes, accounts: [apikey('sa'), apikey('sb'), apikey('sc')], handler }, async ({ am, send, seen }) => {
    await send({ key: KEYS.uma, path: '/tc-acct/sa/v1/messages' });
    assert.equal(am.isBillingRejected(0), true, 'setup: sa is billing-rejected');
    refuse = false;
    seen.length = 0;
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa'], 'ipm.24: the seat queue serves from sa');
  });
});

test('(b) a seat account another request put in error while this one waited for admission is still sent, as in ipm.24', async () => {
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  await withGateway({ routes }, async ({ am, send, seen }) => {
    const admit = am.admit.bind(am);
    let raced = false;
    am.admit = async (/** @type {number} */ index, /** @type {any} */ aborted) => {
      // The race the post-admission re-check is about: the account is put in
      // error after selection, before the send.
      if (!raced && index === 0) { raced = true; am.accounts[0].status = 'error'; }
      return admit(index, aborted);
    };
    const r = await send({ key: KEYS.ana });
    assert.ok(raced, 'setup: the race fired on sa');
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa'], 'the seat request is not re-selected onto its sibling');
  });
});

test('(b) a single-account seat whose account is billing-rejected and refuses with a 403 gets the refusal, not the fleet 402', async () => {
  let mode = 'billing';
  const handler = (/** @type {string} */ who, /** @type {any} */ _req, /** @type {any} */ res) => {
    if (who !== 'sa') return ok(res);
    if (mode === 'billing') return billing(res);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"permission_error","message":"Request not allowed"}}');
  };
  await withGateway({ accounts: [apikey('sa'), apikey('sb'), apikey('sc')], handler }, async ({ am, send }) => {
    await send({ key: KEYS.uma, path: '/tc-acct/sa/v1/messages' });
    assert.equal(am.isBillingRejected(0), true, 'setup: sa is billing-rejected');
    mode = 'refuse';
    const r = await send({ key: KEYS.ana });
    assert.notEqual(r.status, 402, r.text);
    assert.doesNotMatch(r.text, /billing_error/);
  });
});

test('(c) an operator session pin over a key\'s own list pin drops the list: a billing 400 never walks to its tail', async () => {
  const handler = (/** @type {string} */ who, /** @type {any} */ _req, /** @type {any} */ res) => (who === 'sb' ? billing(res) : ok(res));
  await withGateway({ accounts: [apikey('sa'), apikey('sb'), apikey('sc')], handler }, async ({ am, send, seen }) => {
    am.sessionPins.set('sess-op', 'sb');
    am.sessionPins.bind('sess-op', 'ana');
    const r = await send({ key: KEYS.ana, path: '/tc-acct/sa,sc/v1/messages', session: 'sess-op' });
    assert.notEqual(r.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sb'], `the session-pinned account only: ${JSON.stringify(seen)}`);
  });
});

test('(d) a scope 403 on a multi-account seat is never relayed on the client\'s own login', async () => {
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  const handler = (/** @type {string} */ _who, /** @type {any} */ _req, /** @type {any} */ res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(SCOPE_403); };
  await withGateway({ routes, proxy: { requireClientRoute: true }, handler }, async ({ send, seen }) => {
    await send({ key: KEYS.ana, method: 'GET', path: '/api/claude_cli/bootstrap', headers: { authorization: 'Bearer cli-own-login' } });
    assert.ok(seen.length > 0, 'the seat was asked');
    assert.ok(seen.every(s => !s.who.includes('cli-own-login')), `upstream saw ${JSON.stringify(seen)}`);
  });
});

test('(e) through a MITM tunnel a routed key\'s control-plane call is served by its seat; a key on two routes is refused', async () => {
  const { generateCertChain } = await import('../src/x509.js');
  const { createConnectHandler } = await import('../src/mitm.js');
  const { allowLoopbackForward } = await import('../src/forward-target.js');
  const http2 = (await import('node:http2')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const { once } = await import('node:events');
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(String(req.headers.authorization || '').replace(/^Bearer t-/, ''));
    ok(res);
  });
  const upPort = await listen(upstream);
  const origLog = console.log;
  console.log = () => {};
  const am = new AccountManager([oauth('sa'), oauth('sb')], 0.98, {
    clientRoutes: [
      { name: 'seat-a', clients: ['ana'], accounts: ['sa'] },
      { name: 'seat-u1', clients: ['uma'], accounts: ['sa'] },
      { name: 'seat-u2', clients: ['uma'], accounts: ['sb'] },
    ],
  });
  const config = { proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })) }, upstream: `http://127.0.0.1:${upPort}`, mitm: { http1Only: false } };
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} }));
  const mitmPort = await listen(mitm);
  const get = async (/** @type {string} */ key) => {
    const sock = await new Promise((resolve, reject) => {
      const raw = net.connect(mitmPort, '127.0.0.1');
      raw.once('error', reject);
      raw.once('connect', () => raw.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\nProxy-Authorization: Basic ${Buffer.from(`:${key}`).toString('base64')}\r\n\r\n`));
      let buf = Buffer.alloc(0);
      const onData = (/** @type {Buffer} */ d) => {
        buf = Buffer.concat([buf, d]);
        if (!buf.includes('\r\n\r\n')) return;
        raw.removeListener('data', onData);
        if (!/ 200 /.test(buf.toString('utf8').split('\r\n')[0])) { raw.destroy(); reject(new Error(buf.toString('utf8'))); return; }
        const s = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['h2'] }, () => resolve(s));
        s.once('error', reject);
      };
      raw.on('data', onData);
    });
    const client = http2.connect('https://localhost', { createConnection: () => /** @type {any} */ (sock) });
    try {
      const req = client.request({ ':method': 'GET', ':path': '/api/claude_cli/bootstrap' });
      let status = 0;
      req.on('response', (h) => { status = Number(h[':status']); });
      req.resume();
      req.end();
      await once(req, 'close');
      return status;
    } finally {
      client.close();
      /** @type {any} */ (sock).destroy();
    }
  };
  try {
    assert.equal(await get(KEYS.ana), 200);
    assert.deepEqual(seen, ['sa'], 'the seat account, inside the tunnel too');
    seen.length = 0;
    assert.equal(await get(KEYS.uma), 503, 'a key on two seats gets "seat unavailable"');
    assert.deepEqual(seen, [], 'and nothing goes upstream');
  } finally {
    console.log = origLog;
    mitm.closeAllConnections?.(); mitm.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});

test('(f) poolQuotaHeaders never replaces a seat response\'s own quota headers with the pool\'s', async () => {
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  const handler = (/** @type {string} */ _who, /** @type {any} */ _req, /** @type {any} */ res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
    });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  };
  await withGateway({ routes, config: { poolQuotaHeaders: true }, handler }, async ({ am, send, seen }) => {
    for (const a of am.accounts) Object.assign(a.quota, { unified5h: 0.1, unified5hReset: Date.now() + 2 * HOUR });
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa']);
    assert.equal(r.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.9', 'the serving seat account\'s own reading');
    // Control: an unbound key gets the pool's headroom.
    const fleet = await send({ key: KEYS.uma });
    assert.equal(fleet.status, 200);
    assert.notEqual(fleet.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.9', 'setup: the pool rewrite is on');
  });
});

test('(g) a conversation kept on its cordoned account keeps the admission-bucket reading across a reload', async () => {
  const { conversationDigest, pinKeyFor } = await import('../src/conversation.js');
  const tokenFor = (/** @type {string} */ refreshToken) => `t-${refreshToken.slice(2)}`;
  const acct = (/** @type {string} */ name) => ({ name, type: 'oauth', accessToken: tokenFor(`r-${name}`), refreshToken: `r-${name}`, expiresAt: Date.now() + HOUR });
  const ROUTES_A = [{ name: 'r', match: ['claude-*'], bucket: 'bucketA' }];
  const ROUTES_B = [{ name: 'r', match: ['claude-*'], bucket: 'bucketB' }];
  /** @type {string[]} */
  const served = [];
  /** @type {any} */
  let am;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    served.push(bearer === tokenFor('r-qa') ? 'qa' : bearer === tokenFor('r-qb') ? 'qb' : `?${bearer}`);
    if (served.length === 1) {
      am.setRoutes(ROUTES_B);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"token rejected"}}');
      return;
    }
    ok(res);
  });
  const upPort = await listen(upstream);
  am = new AccountManager([acct('qa'), acct('qb')], 0.98, {
    routes: ROUTES_A,
    distributeSessions: true,
    refreshFn: async (/** @type {string} */ refreshToken) => ({ accessToken: tokenFor(refreshToken), refreshToken, expiresAt: Date.now() + HOUR }),
  });
  am.accounts[1].cordoned = true;
  const server = createProxyServer(am, { proxy: { apiKey: ADMIN }, upstream: `http://127.0.0.1:${upPort}` });
  const origLog = console.log;
  console.log = () => {};
  try {
    const port = await listen(server);
    const session = 's-ai2026-cordon';
    const body = JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: 'admission bucket, cordoned' }] });
    const pin = pinKeyFor(session, conversationDigest(Buffer.from(body)));
    am.sessionTracker.touch(pin, 1, 'bucketA', Date.now() - 2000);
    am.sessionTracker.touch(pin, 0, 'bucketB', Date.now() - 1000);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ADMIN, 'x-claude-code-session-id': session },
      body,
    });
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(served, ['qb', 'qb'], 'the retry stays on the cordoned bucketA account, not the post-reload bucketB pin');
  } finally {
    console.log = origLog;
    server.closeAllConnections?.(); server.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});

test('(h) a manual seat reset of a long-lived account is declined with no status read and no claim', async () => {
  const am = new AccountManager([oauth('ll', { id: 'entry-ll', accountUuid: 'u-ll', orgUuid: 'o-ll', longLived: true })], 0.98);
  am.ensureTokenFresh = async () => {};
  let reads = 0, claims = 0;
  const redeemer = new ClaudeResetRedeemer(am, {
    log: () => {}, updateStateFn: async () => {},
    statusFn: async () => { reads++; return { reset: null }; },
    claimFn: async () => { claims++; return { result: 'reset' }; },
  });
  const r = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(r.outcome, 'declined');
  assert.equal(r.reason, 'long_lived_account');
  assert.equal(reads, 0);
  assert.equal(claims, 0);
});

test('(i) the activity-log file line of a relayed seat error stays parseable by the gateway console', async () => {
  const { spawnServer } = await import('../test-helpers/spawn-server.js');
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // The gateway console's activity regex (claude-gateway activity.service.ts), as in client-routes-reload.test.js.
  const CONSOLE_LINE = /^(\d{2}:\d{2}:\d{2})\s+(?:\[([^\]]+)\]\s+)?(?:(\S+)\s+)?([A-Z]{3,7})\s+(\S+)(?:\s+\(([^)]*)\))?\s+→\s+(.+?)(?:\s+\[[^\]]+\])?\s+\((\d{3}|null),\s*([\d.]+)(ms|s)\)/;
  const stub = http.createServer(async (req, res) => { for await (const c of req) void c; billing(res); });
  const stubPort = await listen(stub);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-ai2026-activity-'));
  const activityPath = join(dir, 'activity.log');
  const server = await spawnServer({
    dir,
    config: () => ({
      proxy: { apiKey: ADMIN, clientKeys: [{ name: 'ana', key: KEYS.ana }] },
      upstream: `http://127.0.0.1:${stubPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
      clientRoutes: [{ name: 'seat-a', clients: ['ana'], accounts: ['a@example.com'] }],
    }),
    args: ['--activity-log', activityPath],
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEYS.ana },
      body: JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    await res.text();
    assert.equal(res.status, 400);
    let line;
    for (let i = 0; i < 50 && !line; i++) {
      await new Promise(r => setTimeout(r, 100));
      line = (await readFile(activityPath, 'utf8').catch(() => '')).split('\n').find(l => /\[ana\] POST \/v1\/messages .*→ a@example\.com/.test(l));
    }
    assert.ok(line, 'the request line was written');
    const m = CONSOLE_LINE.exec(line);
    assert.ok(m, `the console parses the line: ${JSON.stringify(line)}`);
    assert.equal(m[8], '400');
    assert.match(line, /\(400, [\d.]+s\) invalid_request_error/, 'the error type follows the parentheses');
  } finally {
    await server.stop();
    stub.close();
  }
});

test('(j) a cordoned account inside a fixed seat keeps serving that seat', async () => {
  await withGateway({}, async ({ am, send, seen }) => {
    am.accounts[0].cordoned = true;
    assert.equal((await send({ key: KEYS.ana })).status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa']);
  });
  const routes = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
  await withGateway({ routes }, async ({ am, send, seen }) => {
    am.accounts[0].cordoned = true;
    assert.equal((await send({ key: KEYS.ana, session: 'sess-cordon' })).status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sa'], 'the seat queue still starts on the cordoned account');
  });
});

test('(k) affinity restore still drops an over-long client key and a key that only looks worker-scoped', async () => {
  const { MAX_KEY_LENGTH } = await import('../src/session-tracker.js');
  const row = (/** @type {string} */ key) => ({ key, sessionId: null, conversation: null, lastSeen: Date.now(), pins: [{ bucket: 'unified7d', account: { id: 'acct-0', provider: 'anthropic' }, at: Date.now() }], threads: [] });
  const longClient = 'x'.repeat(MAX_KEY_LENGTH + 10);
  const fakeWorker = 'w:' + 'Z'.repeat(32) + '\0' + 's'.repeat(160);
  const goodWorker = workerScopedPinKey(keyHashOf('ana-key'), 'w1_' + 'c'.repeat(32), 's'.repeat(160));
  const after = new SessionTracker();
  after.restoreAffinity({ version: 1, sessions: [row(longClient), row(fakeWorker), row(goodWorker)] }, () => 0);
  assert.equal(after.sessions.has(longClient), false);
  assert.equal(after.sessions.has(fakeWorker), false);
  assert.equal(after.sessions.size, 1, 'only the real worker-scoped key comes back');
  assert.equal(after.pinnedAccount(goodWorker, 'unified7d'), 0);
});

// ── (l) a multi-account seat whose every account fails ─────────────────────

// Measured on ipm.24 (b4d3a87) and on this branch with the same scenarios: a
// bound request never reaches the fleet "all accounts exhausted" branch, so it
// carries no #597 `details` and takes no #603/hold retry; it answers from the
// seat (spent copy) or relays the seat account's own error, and never leaves
// the seat. The bodies below are ipm.24's, byte for byte.
const SEAT2 = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa', 'sb'] }];
const ERR_500 = '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
const ERR_529 = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const spent = (/** @type {'5h'|'7d'} */ win, /** @type {number} */ ms) => (/** @type {any} */ res) => {
  const reset = String(Math.floor((Date.now() + ms) / 1000));
  res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', [`anthropic-ratelimit-unified-${win}-status`]: 'rejected', [`anthropic-ratelimit-unified-${win}-reset`]: reset, 'anthropic-ratelimit-unified-reset': reset });
  res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
};

/**
 * @param {(res: any) => void} fail every seat account's answer once failing
 * @param {boolean} pinned warm the conversation onto the seat first
 * @param {(r: { status: number, text: string, headers: any }[], seen: { who: string }[]) => void} check
 */
async function allSeatAccountsFail(fail, pinned, check) {
  let failing = !pinned;
  const handler = (/** @type {string} */ who, /** @type {any} */ _req, /** @type {any} */ res) => (who === 'sc' || !failing ? ok(res) : fail(res));
  await withGateway({ routes: SEAT2, handler }, async ({ send, seen }) => {
    /** @type {string[]} */
    const logs = [];
    const quiet = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      const headers = pinned ? { 'x-claude-code-session-id': 'sess-l' } : {};
      const body = JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: 'hi' }] });
      if (pinned) assert.equal((await send({ key: KEYS.ana, headers, body })).status, 200);
      seen.length = 0;
      failing = true;
      const t0 = Date.now();
      const answers = [await send({ key: KEYS.ana, headers, body }), await send({ key: KEYS.ana, headers, body })];
      assert.ok(Date.now() - t0 < 10_000, 'answered at once, no hold');
      for (const a of answers) {
        const parsed = JSON.parse(a.text);
        assert.equal('details' in (parsed.error ?? {}), false, `no #597 details: ${a.text}`);
        assert.ok(a.headers.get('x-teamclaude-request-id'), 'the #600 header is the one addition');
      }
      assert.ok(seen.every(s => s.who === 'sa' || s.who === 'sb'), `never outside the seat: ${JSON.stringify(seen)}`);
      assert.deepEqual(logs.filter(l => /exhausted|holding connection/i.test(l)), [], 'never the fleet exhausted/hold branch');
      check(answers, seen);
    } finally {
      console.log = quiet;
    }
  });
}

test('(l) a two-account seat whose accounts all answer 5xx relays the seat\'s own error, as ipm.24', async () => {
  const e500 = (/** @type {any} */ res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(ERR_500); };
  const e529 = (/** @type {any} */ res) => { res.writeHead(529, { 'content-type': 'application/json' }); res.end(ERR_529); };
  await allSeatAccountsFail(e500, false, (answers, seen) => {
    assert.deepEqual(answers.map(a => [a.status, a.text]), [[500, ERR_500], [500, ERR_500]]);
    assert.deepEqual(seen.map(s => s.who), ['sa', 'sb', 'sa', 'sb']);
  });
  await allSeatAccountsFail(e529, true, (answers, seen) => {
    assert.deepEqual(answers.map(a => [a.status, a.text]), [[529, ERR_529], [529, ERR_529]]);
    assert.deepEqual(seen.map(s => s.who), ['sa', 'sa'], 'the pinned account only');
  });
});

test('(l) a two-account seat whose accounts are all spent answers the seat\'s 429 copy, as ipm.24', async () => {
  await allSeatAccountsFail(spent('5h', HOUR), false, (answers, seen) => {
    for (const a of answers) {
      assert.equal(a.status, 429);
      assert.equal(a.headers.get('x-should-retry'), 'false');
      assert.equal(a.headers.get('anthropic-ratelimit-unified-5h-status'), 'rejected');
      assert.match(JSON.parse(a.text).error.message, /^Your Claude seat "seat-a" is out of quota until \S+Z\. Use `cg kimi on` to keep working meanwhile\.$/);
    }
    assert.deepEqual(seen.map(s => s.who), ['sa', 'sb'], 'the second answer comes from the recording');
  });
  // AI-2049: the pinned sa continues on sb inside the first request; sb is
  // spent too, so both answers are the stop with no sibling left.
  await allSeatAccountsFail(spent('7d', 48 * HOUR), true, (answers, seen) => {
    assert.deepEqual(answers.map(a => a.status), [429, 429]);
    for (const a of answers) {
      assert.match(JSON.parse(a.text).error.message, /^Your Claude seat "seat-a" is out of quota until \S+Z\. This conversation is pinned to "sb", and no other account on this seat can serve now\. Use `cg kimi on` to keep working meanwhile\.$/);
      assert.equal(a.headers.get('anthropic-ratelimit-unified-7d-status'), 'rejected');
    }
    assert.deepEqual(seen.map(s => s.who), ['sa', 'sb']);
  });
});
