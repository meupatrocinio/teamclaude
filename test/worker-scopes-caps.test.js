import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import {
  SessionTracker, SESSION_KNOWN_TTL_MS,
  MAX_WORKERS_PER_CLIENT, MAX_WORKER_SESSIONS_PER_CLIENT,
  MAX_WORKERS_GLOBAL, MAX_WORKER_SESSIONS_GLOBAL,
} from '../src/session-tracker.js';
import { createProxyServer } from '../src/server.js';
import { keyHashOf } from '../src/client-routes.js';

// AI-1960 (AC14): the worker-scope caps fail closed. 64 worker ids / 256
// worker-scoped sessions per client key, 1,024 / 2,048 process-wide; past them
// admission is a non-unified 429 with x-should-retry: false — never an eviction
// of another client's state, never a collapse to the legacy pin, never an
// in-flight record evicted. Idle TTL, completion/cancellation or a restart
// restores admission with no operator action. Status exposes the counts to the
// operator only, with no keyHash or worker-id material anywhere (E14).

const T = { timeout: 30000 };
const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

const keyHash = (i) => keyHashOf(`key-${i}`);
const workerId = (i) => `w1_${i.toString(16).padStart(32, '0')}`;
// A scoped pin key in the internally generated shape (un-spoofable prefix), so
// it bypasses the client-key truncation exactly like a real one.
const pinKey = (w, s) => `w:${'ab'.repeat(16)}\x00sess-${w}-${s}`;

function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

// ── per-client caps ──────────────────────────────────────────────────────────

test('the 65th distinct worker id for one key is refused; other clients are unaffected', () => {
  const st = new SessionTracker();
  for (let w = 0; w < MAX_WORKERS_PER_CLIENT; w++) {
    assert.equal(st.admitWorkerScope(keyHash(0), workerId(w), pinKey(w, 0)), true, `worker ${w}`);
  }
  assert.equal(st.admitWorkerScope(keyHash(0), workerId(64), pinKey(64, 0)), false, 'the 65th fails closed');
  // Re-admission of an already-known pair is free, even at the cap.
  assert.equal(st.admitWorkerScope(keyHash(0), workerId(0), pinKey(0, 0)), true, 'a retried request never 429s against its own scope');
  // Another client admits normally.
  assert.equal(st.admitWorkerScope(keyHash(1), workerId(64), pinKey(64, 0)), true, 'another client is unaffected');
  const counts = st.workerScopeCounts();
  assert.equal(counts.workers, MAX_WORKERS_PER_CLIENT + 1);
  assert.deepEqual(counts.maxPerClient, { workers: 64, sessions: 256 });
});

test('the 257th scoped session evicts only that client\'s idle records; all in flight means 429', () => {
  const st = new SessionTracker();
  const other = keyHash(9);
  // The other client's scoped sessions, and a legacy (unscoped) record of the
  // saturated client, must both survive.
  assert.equal(st.admitWorkerScope(other, workerId(0), pinKey('other', 0)), true);
  st.touch(pinKey('other', 0), 0, 'unified7d');
  st.touch('legacy-session', 1, 'unified7d');

  const me = keyHash(0);
  for (let s = 0; s < MAX_WORKER_SESSIONS_PER_CLIENT; s++) {
    const pin = pinKey(0, s);
    assert.equal(st.admitWorkerScope(me, workerId(0), pin), true);
    st.touch(pin, 0, 'unified7d');
  }
  // All idle: the 257th evicts this client's oldest idle scoped record.
  assert.equal(st.admitWorkerScope(me, workerId(0), pinKey(0, 'new')), true);
  assert.equal(st.sessions.has(pinKey(0, 0)), false, 'the oldest idle scoped record made room');
  assert.equal(st.sessions.has(pinKey('other', 0)), true, 'never another client\'s state');
  assert.equal(st.sessions.has('legacy-session'), true, 'never a collapse into or out of the legacy space');
  const scope = st.workerRegistry.get(me);
  assert.equal(scope.sessions.size, MAX_WORKER_SESSIONS_PER_CLIENT);

  // Everything in flight: no eviction is possible, so admission fails closed.
  const st2 = new SessionTracker();
  for (let s = 0; s < MAX_WORKER_SESSIONS_PER_CLIENT; s++) {
    const pin = pinKey(0, s);
    assert.equal(st2.admitWorkerScope(me, workerId(0), pin), true);
    st2.beginRequest(pin); // in flight, never evictable
  }
  assert.equal(st2.admitWorkerScope(me, workerId(0), pinKey(0, 'new')), false, 'no idle record to evict: 429');
  // Completion of one in-flight request makes it evictable: admission resumes.
  st2.endRequest(pinKey(0, 0));
  assert.equal(st2.admitWorkerScope(me, workerId(0), pinKey(0, 'new')), true, 'completion restored admission');
});

test('idle TTL expiry restores admission with no operator action', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  const me = keyHash(0);
  for (let w = 0; w < MAX_WORKERS_PER_CLIENT; w++) {
    assert.equal(st.admitWorkerScope(me, workerId(w), pinKey(w, 0), clock.t), true);
  }
  assert.equal(st.admitWorkerScope(me, workerId(64), pinKey(64, 0), clock.t), false);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  // The next admission prunes what the TTL expired: the cap no longer binds.
  assert.equal(st.admitWorkerScope(me, workerId(64), pinKey(64, 0), clock.t), true, 'the TTL drained the saturated scope');
  assert.equal(st.workerScopeCounts(clock.t).workers, 1);
});

test('a refused admission registers nothing — no worker, no session, no scope', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  const me = keyHash(0);
  for (let w = 0; w < MAX_WORKERS_PER_CLIENT; w++) {
    assert.equal(st.admitWorkerScope(me, workerId(w), pinKey(w, 0), clock.t), true);
  }
  // Ten refused new-worker admissions must not consume worker slots.
  for (let i = 0; i < 10; i++) {
    assert.equal(st.admitWorkerScope(me, workerId(100 + i), pinKey(100 + i, 0), clock.t), false);
  }
  assert.equal(st.workerScopeCounts(clock.t).workers, MAX_WORKERS_PER_CLIENT, 'a refusal holds no worker id');
  assert.equal(st.workerScopeCounts(clock.t).sessions, MAX_WORKERS_PER_CLIENT, 'a refusal registers no session');
  // And nothing lingers to survive a TTL sweep either.
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.sweep(clock.t);
  assert.equal(st.workerScopeCounts(clock.t).workers, 0);
});

test('the global session cap refuses before any same-client eviction runs', () => {
  const st = new SessionTracker();
  // 8 clients x 256 sessions = exactly the global cap; client 0 is at its own
  // per-client cap too, with every record idle.
  for (let c = 0; c < 8; c++) {
    for (let s = 0; s < 256; s++) {
      assert.equal(st.admitWorkerScope(keyHash(c), workerId(c), pinKey(c, s)), true);
    }
  }
  assert.equal(st.workerScopeCounts().sessions, MAX_WORKER_SESSIONS_GLOBAL);
  // Client 0 asks for a 257th: refused by the GLOBAL cap, and its own idle
  // records must NOT be destroyed making room for a request that fails anyway.
  assert.equal(st.admitWorkerScope(keyHash(0), workerId(0), pinKey(0, 'new')), false);
  for (let s = 0; s < 256; s++) {
    assert.ok(st.sessions.has(pinKey(0, s)), `client 0's session ${s} was evicted for a refused request`);
  }
});

// ── global caps ──────────────────────────────────────────────────────────────

test('the process-wide worker cap is 1,024 across clients', () => {
  const st = new SessionTracker();
  // 16 clients x 64 workers = exactly the global cap.
  for (let c = 0; c < 16; c++) {
    for (let w = 0; w < 64; w++) {
      assert.equal(st.admitWorkerScope(keyHash(c), workerId(c * 64 + w), pinKey(c * 64 + w, 0)), true);
    }
  }
  assert.equal(st.workerScopeCounts().workers, MAX_WORKERS_GLOBAL);
  // A 17th client's first worker id fails closed — its per-client cap is not
  // what binds — and every existing scope keeps working.
  assert.equal(st.admitWorkerScope(keyHash(16), workerId(0), pinKey('x', 0)), false);
  assert.equal(st.admitWorkerScope(keyHash(0), workerId(0), pinKey(0, 1)), true, 'an existing worker admits a new session');
});

test('the process-wide session cap is 2,048 across clients, with no cross-client eviction', () => {
  const st = new SessionTracker();
  // 8 clients x 256 sessions = exactly the global session cap.
  for (let c = 0; c < 8; c++) {
    for (let s = 0; s < 256; s++) {
      assert.equal(st.admitWorkerScope(keyHash(c), workerId(c), pinKey(c, s)), true, `c${c} s${s}`);
    }
  }
  assert.equal(st.workerScopeCounts().sessions, MAX_WORKER_SESSIONS_GLOBAL);
  // A ninth client cannot evict anyone else's state to make room: 429.
  assert.equal(st.admitWorkerScope(keyHash(8), workerId(8), pinKey(8, 0)), false);
  for (let c = 0; c < 8; c++) {
    assert.equal(st.workerRegistry.get(keyHash(c)).sessions.size, 256, `client ${c} keeps all its sessions`);
  }
});

// ── through the gateway: the 429 shape and the status surface ───────────────

async function withGateway(fn) {
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    attempts.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa')], 0.98, {
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }] },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  const send = async (worker, session) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'ana-key',
        'x-claude-code-session-id': session,
        'x-teamclaude-worker-id': worker,
      },
      body: JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: 'hello' }] }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON */ }
    return { status: res.status, headers: res.headers, json };
  };
  const status = async (key = 'admin-key') => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': key } });
    return res.json();
  };
  try {
    await fn({ send, status, attempts, am });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('a saturated client gets a non-unified 429; the existing scopes keep working', T, async () => {
  await withGateway(async ({ send, attempts, am }) => {
    for (let w = 0; w < MAX_WORKERS_PER_CLIENT; w++) {
      const r = await send(workerId(w), `s-cap-${w}`);
      assert.equal(r.status, 200, `worker ${w}`);
    }
    const before = attempts.length;
    const r = await send(workerId(64), 's-cap-64');
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('x-should-retry'), 'false');
    assert.equal(r.json?.error?.type, 'rate_limit_error');
    assert.equal(r.headers.get('anthropic-ratelimit-unified-status'), null, 'non-unified: no upstream window headers');
    assert.equal(attempts.length, before, 'the capped request never reached upstream');
    // The existing 64 scopes are unaffected, and the tracker holds no legacy
    // record for the refused request (never a collapse to the legacy pin).
    assert.equal((await send(workerId(0), 's-cap-0')).status, 200);
    for (const key of am.sessionTracker.sessions.keys()) assert.ok(!key.startsWith('s-cap-64'), 'no legacy record for the refused request');
  });
});

test('status: capability flip, admin-only workerScopes, no keyHash or worker id anywhere (E14)', T, async () => {
  await withGateway(async ({ send, status }) => {
    assert.equal((await send(workerId(7), 's-status')).status, 200);
    const admin = await status();
    assert.equal(admin.capabilities.workerIdentity, true);
    assert.deepEqual(admin.workerScopes, {
      workers: 1,
      sessions: 1,
      maxPerClient: { workers: 64, sessions: 256 },
    });
    const adminRaw = JSON.stringify(admin);
    assert.ok(!adminRaw.includes(keyHashOf('ana-key')), 'the keyHash leaked into admin status');
    assert.ok(!adminRaw.includes(workerId(7)), 'the worker id leaked into admin status');

    const client = await status('ana-key');
    assert.equal(client.capabilities.workerIdentity, true);
    assert.ok(!('workerScopes' in client), 'a client key never reads the scope counts');
    const clientRaw = JSON.stringify(client);
    assert.ok(!clientRaw.includes(keyHashOf('ana-key')) && !clientRaw.includes(workerId(7)));
  });
});

// ── the heap budget (owner amendment: never skips) ──────────────────────────

test('opted structures at global saturation cost at most 128 MiB of heap', T, async () => {
  const helper = fileURLToPath(new URL('../test-helpers/worker-scope-heap.js', import.meta.url));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-gc', helper], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: null, out, err: err + String(e) }));
  });
  assert.equal(result.code, 0, `the heap probe must run and measure (never skip): ${result.err}`);
  const lastLine = result.out.trim().split('\n').pop();
  let report = null;
  try { report = JSON.parse(lastLine); } catch { /* handled below */ }
  assert.ok(report && Number.isFinite(report.delta), `unparseable probe output: ${result.out} ${result.err}`);
  assert.equal(report.workers, MAX_WORKERS_GLOBAL);
  assert.equal(report.sessions, MAX_WORKER_SESSIONS_GLOBAL);
  assert.ok(report.delta <= 128 * 1024 * 1024,
    `the opted structures at global saturation grew the heap by ${(report.delta / 1024 / 1024).toFixed(1)} MiB (budget 128 MiB)`);
});
