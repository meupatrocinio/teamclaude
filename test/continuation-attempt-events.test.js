import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { keyHashOf, offerKeyRef } from '../src/client-routes.js';
import { createContinuationTelemetry } from '../src/continuation-telemetry.js';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// Durable continuation-attempt events (IPM fork, AI-1959 / AI-1902 phase 3):
// one JSONL line per continuation-selected sibling send — a force hop or a
// taken recommend offer — written (open/chmod/write/fsync/close) BEFORE the
// send, so the console can count continuations across restarts. Off unless
// config.continuationAttemptsLog names a path; a failed write never fails the
// request and flips the admin-only continuationTelemetry status instead.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));

const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key' };
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const root = (client, key, mode, revision) => ({ client, keyHash: keyHashOf(key), mode, revision });

const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
const ok = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(okBody);
};
const spent = (res) => {
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
  });
  res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const T1_KEYS = ['v', 'type', 'id', 'at', 'client', 'keyRef', 'revision', 'mode', 'source', 'requestId', 'hop', 'from', 'to', 'model'];

const readEvents = (logPath) => {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  if (!raw) return [];
  assert.ok(raw.endsWith('\n'), 'every event line is newline-terminated');
  const lines = raw.trimEnd().split('\n');
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) < 4096, `event line stays under 4 KiB (${Buffer.byteLength(line)})`);
  }
  return lines.map((l) => JSON.parse(l));
};

const tmpdir = () => fs.mkdtempSync(join(os.tmpdir(), 'tc-cont-events-'));

async function withGateway({ handler = (_who, _req, res) => ok(res), routes, accounts = null, policies = undefined, attemptsLog = null, clientKeys = null } = {}, fn) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    handler(who, req, res);
  });
  const upPort = await listen(upstream);
  const list = accounts ?? [oauth('qa'), oauth('qb'), oauth('qc'), oauth('qr')];
  const am = new AccountManager(list, 0.98, {
    clientRoutes: routes ?? [
      { name: 's1+s2+s3', clients: ['amy'], accounts: ['qa', 'qb', 'qc'] },
      { name: 'seat-r', clients: ['ben'], accounts: ['qr'] },
    ],
    continuationPolicies: policies,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: clientKeys ?? Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
    ...(attemptsLog ? { continuationAttemptsLog: attemptsLog } : {}),
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  const send = async ({ key = KEYS.amy, session = 's-1', text = 'hello', model = 'claude-opus-4-1', policy } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-claude-code-session-id': session,
        ...(policy === undefined ? {} : { 'x-teamclaude-seat-policy': policy }),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON stays raw */ }
    return { status: res.status, headers: res.headers, raw, json };
  };
  const control = async (path, key = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-api-key': key } });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn({ send, control, seen, am, config });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

// ── writer unit tests ────────────────────────────────────────────────────────

test('writer: one record is one newline-terminated line; status counts it', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    const t = createContinuationTelemetry({ path: logPath });
    const event = { v: 1, type: 'attempt', id: 'x' };
    await t.record(event);
    assert.deepEqual(readEvents(logPath), [event]);
    assert.deepEqual(t.status(), { ok: true, lastError: null, lastErrorAt: null, events: 1 });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o644, 'the log is created 0644');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: process umask 0o077 still leaves a 0644 file (owner amendment)', async () => {
  const dir = tmpdir();
  const oldUmask = process.umask(0o077);
  try {
    const logPath = join(dir, 'attempts.jsonl');
    const t = createContinuationTelemetry({ path: logPath });
    await t.record({ v: 1, type: 'attempt' });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o644, 'chmod after open defeats the restrictive umask');
  } finally {
    process.umask(oldUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: an open failure flips the status to open_failed and never throws', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'no-such-dir', 'attempts.jsonl');
    const t = createContinuationTelemetry({ path: logPath });
    await t.record({ v: 1 });
    const s = t.status();
    assert.equal(s.ok, false);
    assert.equal(s.lastError, 'open_failed');
    assert.match(s.lastErrorAt, ISO_MS);
    assert.equal(s.events, 0);
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: a chmod failure classifies as open_failed (it is part of the per-event prepare)', async () => {
  const dir = tmpdir();
  try {
    let closed = false;
    const open = async () => ({
      chmod: async () => { throw new Error('EPERM'); },
      write: async () => { throw new Error('unreachable'); },
      sync: async () => {},
      close: async () => { closed = true; },
    });
    const t = createContinuationTelemetry({ path: join(dir, 'attempts.jsonl'), open });
    await t.record({ v: 1 });
    assert.equal(t.status().lastError, 'open_failed');
    assert.equal(closed, true, 'the handle is still closed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: a write failure classifies as write_failed, an fsync failure as fsync_failed', async () => {
  const dir = tmpdir();
  try {
    for (const [failAt, kind] of [['write', 'write_failed'], ['sync', 'fsync_failed']]) {
      let closed = false;
      const handle = {
        chmod: async () => {},
        write: async (s) => ({ bytesWritten: Buffer.byteLength(s), buffer: Buffer.alloc(0) }),
        sync: async () => {},
        close: async () => { closed = true; },
      };
      handle[failAt] = async () => { throw new Error('boom'); };
      const t = createContinuationTelemetry({ path: join(dir, `${kind}.jsonl`), open: async () => handle });
      await t.record({ v: 1 });
      const s = t.status();
      assert.equal(s.ok, false);
      assert.equal(s.lastError, kind);
      assert.match(s.lastErrorAt, ISO_MS);
      assert.equal(s.events, 0);
      assert.equal(closed, true, 'the handle is still closed');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: a short write classifies as write_failed — never fsynced, never counted', async () => {
  const dir = tmpdir();
  try {
    let synced = false;
    let closed = false;
    const handle = {
      chmod: async () => {},
      write: async () => ({ bytesWritten: 2, buffer: Buffer.alloc(0) }),
      sync: async () => { synced = true; },
      close: async () => { closed = true; },
    };
    const t = createContinuationTelemetry({ path: join(dir, 'short.jsonl'), open: async () => handle });
    await t.record({ v: 1, type: 'attempt' });
    const s = t.status();
    assert.equal(s.ok, false);
    assert.equal(s.lastError, 'write_failed');
    assert.equal(s.events, 0);
    assert.equal(synced, false, 'a truncated line is never fsynced');
    assert.equal(closed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: a short write is rolled back so the next event is not glued to the newline-less fragment', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let short = true;
    const realOpen = fs.promises.open;
    const open = async (...args) => {
      const h = await realOpen(...args);
      if (!short) return h;
      // A real file, a real 2-byte write, a short report — then the rollback
      // under test must truncate those 2 bytes back off.
      return {
        chmod: (...a) => h.chmod(...a),
        write: async (s) => {
          const frag = Buffer.from(s).subarray(0, 2);
          await h.write(frag);
          return { bytesWritten: 2, buffer: frag };
        },
        stat: () => h.stat(),
        truncate: (n) => h.truncate(n),
        sync: () => h.sync(),
        close: () => h.close(),
      };
    };
    const t = createContinuationTelemetry({ path: logPath, open });
    await t.record({ v: 1, n: 'short' });
    assert.equal(t.status().lastError, 'write_failed');
    short = false;
    await t.record({ v: 1, n: 'full' });
    assert.equal(t.status().ok, true);
    assert.deepEqual(readEvents(logPath), [{ v: 1, n: 'full' }], 'no glued, unparseable second line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: the last error stays sticky across a later success', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let fail = true;
    const realOpen = fs.promises.open;
    const open = async (...args) => {
      if (fail) throw new Error('gone');
      return realOpen(...args);
    };
    const t = createContinuationTelemetry({ path: logPath, open });
    await t.record({ v: 1, n: 1 });
    const failed = t.status();
    assert.equal(failed.ok, false);
    assert.equal(failed.lastError, 'open_failed');
    fail = false;
    await t.record({ v: 1, n: 2 });
    const s = t.status();
    assert.equal(s.ok, true, 'a later success flips ok back');
    assert.equal(s.events, 1);
    assert.equal(s.lastError, 'open_failed', 'sticky: the LAST error, not the current state');
    assert.equal(s.lastErrorAt, failed.lastErrorAt);
    assert.equal(readEvents(logPath).length, 1, 'only the successful record landed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: N concurrent records append N intact parseable lines', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    const t = createContinuationTelemetry({ path: logPath });
    const N = 20;
    await Promise.all(Array.from({ length: N }, (_, i) => t.record({ v: 1, type: 'attempt', id: `ev-${i}` })));
    const events = readEvents(logPath);
    assert.equal(events.length, N);
    assert.deepEqual(new Set(events.map((e) => e.id)).size, N, 'every line is one whole event');
    assert.equal(t.status().events, N);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: a rename between events recreates the configured path', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    const t = createContinuationTelemetry({ path: logPath });
    await t.record({ v: 1, n: 1 });
    fs.renameSync(logPath, `${logPath}.1`);
    await t.record({ v: 1, n: 2 });
    assert.deepEqual(readEvents(logPath), [{ v: 1, n: 2 }], 'the fresh path holds exactly the new event');
    assert.deepEqual(readEvents(`${logPath}.1`), [{ v: 1, n: 1 }], 'the rotated file keeps its lines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer: disabled — unset path is fully off; a seeded disable never writes', async () => {
  const dir = tmpdir();
  try {
    const off = createContinuationTelemetry();
    await off.record({ v: 1 });
    assert.deepEqual(off.status(), { ok: true, lastError: null, lastErrorAt: null, events: 0 });

    const logPath = join(dir, 'attempts.jsonl');
    const seeded = createContinuationTelemetry({ path: logPath, disabled: true });
    const s = seeded.status();
    assert.equal(s.ok, false);
    assert.equal(s.lastError, 'open_failed');
    assert.match(s.lastErrorAt, ISO_MS);
    assert.equal(s.events, 0);
    await seeded.record({ v: 1 });
    assert.equal(fs.existsSync(logPath), false, 'a seeded-disabled writer never touches the disk');
    assert.equal(seeded.status().events, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration: the event is written at the send point ──────────────────────

test('FORCE_HOP: one event, written before the sibling send, matching the T1 shape', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let qaSpent = false;
    let seenAtSend = null;
    const policies = [root('amy', 'amy-key', 'force', 'r_one')];
    await withGateway({
      attemptsLog: logPath,
      policies,
      handler: (who, _req, res) => {
        if (who === 'qb') seenAtSend = readEvents(logPath);
        if (who === 'qa' && qaSpent) return spent(res);
        ok(res);
      },
    }, async ({ send, control, seen }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      const r = await send();
      assert.equal(r.status, 200);
      assert.deepEqual(seen, ['qa', 'qa', 'qb']);
      const events = readEvents(logPath);
      assert.equal(events.length, 1, 'exactly one continuation event');
      const ev = events[0];
      assert.deepEqual(Object.keys(ev), T1_KEYS, 'the event line is exactly the T1 shape');
      assert.equal(ev.v, 1);
      assert.equal(ev.type, 'attempt');
      assert.match(ev.id, UUID_V4);
      assert.match(ev.at, ISO_MS);
      assert.equal(ev.client, 'amy');
      assert.equal(ev.keyRef, offerKeyRef(keyHashOf('amy-key')), 'the C9 keyRef, never the keyHash');
      assert.equal(ev.revision, 'r_one');
      assert.equal(ev.mode, 'force');
      assert.equal(ev.source, 'root');
      assert.match(ev.requestId, /^\d+$/);
      assert.equal(ev.hop, 1);
      assert.equal(ev.from, 'qa');
      assert.equal(ev.to, 'qb');
      assert.equal(ev.model, 'claude-opus-4-1');
      // Written BEFORE the sibling send: when qb's upstream handler ran, the
      // event was already durable on disk.
      assert.deepEqual(seenAtSend, events, 'the event was on disk before the sibling send');
      assert.deepEqual((await control('/teamclaude/status')).json.continuationTelemetry,
        { ok: true, lastError: null, lastErrorAt: null, events: 1 });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FORCE_HOP_FAILED_UPSTREAM: the hop destination 5xx still leaves the pre-send event on disk', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let qaSpent = false;
    const policies = [root('amy', 'amy-key', 'force', 'r_one')];
    await withGateway({
      attemptsLog: logPath,
      policies,
      handler: (who, _req, res) => {
        if (who === 'qa' && qaSpent) return spent(res);
        if (who === 'qb') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"type":"error","error":{"type":"api_error"}}');
          return;
        }
        ok(res);
      },
    }, async ({ send }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      await send();
      const events = readEvents(logPath);
      assert.ok(events.length >= 1, 'the hop event survived the destination failing');
      assert.equal(events[0].mode, 'force');
      assert.equal(events[0].from, 'qa');
      assert.equal(events[0].to, 'qb');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('force hops chain: hop numbers and from/to follow each continuation', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    const names = ['c0', 'c1', 'c2', 'c3'];
    let allSpent = false;
    const policies = [root('amy', 'amy-key', 'force', 'r_chain')];
    await withGateway({
      attemptsLog: logPath,
      policies,
      routes: [{ name: 'four', clients: ['amy'], accounts: names }],
      accounts: names.map(oauth),
      handler: (_who, _req, res) => (allSpent ? spent(res) : ok(res)),
    }, async ({ send, seen }) => {
      assert.equal((await send()).status, 200);
      allSpent = true;
      assert.equal((await send()).status, 429, 'no sibling left after c3');
      assert.deepEqual(seen, ['c0', 'c0', 'c1', 'c2', 'c3']);
      const events = readEvents(logPath);
      assert.equal(events.length, 3, 'one event per continuation send, none for the initial attempt or the dead end');
      assert.deepEqual(events.map((e) => e.hop), [1, 2, 3]);
      assert.deepEqual(events.map((e) => [e.from, e.to]), [['c0', 'c1'], ['c1', 'c2'], ['c2', 'c3']]);
      assert.ok(events.every((e) => e.mode === 'force' && e.source === 'root' && e.revision === 'r_chain'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RECOMMEND_TAKEN: a taken offer records one recommend event with hop 1', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let qaSpent = false;
    const policies = [root('amy', 'amy-key', 'recommend', 'r_rec')];
    await withGateway({
      attemptsLog: logPath,
      policies,
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      assert.equal((await send()).status, 429, 'the offer is disclosed, nothing sent to a sibling');
      assert.equal(readEvents(logPath).length, 0, 'the disclosed offer writes no event');
      assert.equal((await send()).status, 200, 'the next prompt confirms and takes the offer');
      const events = readEvents(logPath);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.deepEqual(Object.keys(ev), T1_KEYS);
      assert.equal(ev.mode, 'recommend');
      assert.equal(ev.hop, 1);
      assert.equal(ev.from, 'qa');
      assert.equal(ev.to, 'qb');
      assert.equal(ev.source, 'root');
      assert.equal(ev.revision, 'r_rec');
      assert.equal(ev.keyRef, offerKeyRef(keyHashOf('amy-key')));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RECOMMEND_THEN_FORCE: a taken recommend hop followed by a force hop numbers the sends 1, 2 — never 1, 1', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let qaSpent = false;
    await withGateway({
      attemptsLog: logPath,
      // s1 (qa) recommend, s2/s3 (qb/qc) force: the offer lands on qb, qb's
      // own 429 then force-hops to qc inside the same request.
      handler: (who, _req, res) => ((who === 'qa' && qaSpent) || who === 'qb' ? spent(res) : ok(res)),
    }, async ({ send, seen }) => {
      const policy = 's1=recommend,s2=force,s3=force';
      assert.equal((await send({ policy })).status, 200);
      qaSpent = true;
      assert.equal((await send({ policy })).status, 429, 'recommend discloses the offer, nothing sent to a sibling');
      assert.equal(readEvents(logPath).length, 0);
      assert.equal((await send({ policy })).status, 200, 'offer taken to qb; qb spent upstream; force hop on to qc');
      assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
      const events = readEvents(logPath);
      assert.deepEqual(events.map((e) => [e.mode, e.hop, e.from, e.to]), [
        ['recommend', 1, 'qa', 'qb'],
        // Arming-time numbering off continuationHops (which the recommend path
        // never increments) would call this hop 1 too — a (requestId, hop)
        // collision. Send-time numbering keeps it 2.
        ['force', 2, 'qb', 'qc'],
      ]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LEGACY_FORCE_KEYREF: a legacy-source force hop on a client-key request carries the non-null C9 keyRef', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let qaSpent = false;
    await withGateway({
      attemptsLog: logPath,
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send }) => {
      assert.equal((await send({ policy: '*=force' })).status, 200);
      qaSpent = true;
      assert.equal((await send({ policy: '*=force' })).status, 200);
      const events = readEvents(logPath);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.equal(ev.mode, 'force');
      assert.equal(ev.source, 'legacy');
      assert.equal(ev.revision, null, 'a legacy request has no root revision');
      assert.equal(ev.keyRef, offerKeyRef(keyHashOf('amy-key')), 'keyRef is set for every client-key request, root or legacy (owner amendment)');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NO_EVENT: initial 429, no sibling, key revoked mid-request, and a pre-send bail after arming write nothing', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    // (1) recommend root: the initial 429 only records an offer.
    let qaSpent = false;
    const recommend = [root('amy', 'amy-key', 'recommend', 'r_rec')];
    await withGateway({
      attemptsLog: logPath,
      policies: recommend,
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      assert.equal((await send()).status, 429);
      assert.equal(readEvents(logPath).length, 0, 'the initial 429 and the recorded offer write nothing');
    });

    // (2) force root on a single-account seat: no sibling to hop to.
    let qrSpent = false;
    const forceBen = [root('ben', 'ben-key', 'force', 'r_ben')];
    await withGateway({
      attemptsLog: logPath,
      policies: forceBen,
      handler: (who, _req, res) => (who === 'qr' && qrSpent ? spent(res) : ok(res)),
    }, async ({ send }) => {
      assert.equal((await send({ key: KEYS.ben })).status, 200);
      qrSpent = true;
      assert.equal((await send({ key: KEYS.ben })).status, 429);
      assert.equal(readEvents(logPath).length, 0, 'no sibling, no event');
    });

    // (3) force root with the key revoked mid-request: the hop is refused (E11).
    qaSpent = false;
    let revoke = null;
    const forceAmy = [root('amy', 'amy-key', 'force', 'r_one')];
    await withGateway({
      attemptsLog: logPath,
      policies: forceAmy,
      handler: (who, _req, res) => {
        if (who === 'qa' && qaSpent) {
          revoke?.();
          return spent(res);
        }
        ok(res);
      },
    }, async ({ send, config }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      const orig = config.proxy.clientKeys;
      revoke = () => { config.proxy.clientKeys = []; };
      try {
        const r = await send();
        assert.equal(r.status, 429);
        assert.match(r.json?.error?.message ?? '', /revoked or rotated/);
        assert.equal(readEvents(logPath).length, 0, 'a key-revoked stop arms no hop and writes nothing');
      } finally {
        config.proxy.clientKeys = orig;
      }
    });

    // (4) pre-send bail: the hop to qb is armed, then qb turns
    // entitlement-denied during admission (a state that did not exist when the
    // hop was armed — the exact race the send-point re-check exists for). The
    // request bails before the send and the marker dies with it.
    qaSpent = false;
    await withGateway({
      attemptsLog: logPath,
      policies: forceAmy,
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send, am }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      const qbIdx = am.accounts.find((a) => a.name === 'qb').index;
      const origAdmit = am.admit.bind(am);
      am.admit = async (index, isAborted) => {
        if (index === qbIdx) {
          // The hop to qb was armed by the time its attempt queues for
          // admission; the denial lands now, between arming and the send.
          am.accounts[qbIdx].entitlementDeniedUntil = Date.now() + HOUR;
        }
        return origAdmit(index, isAborted);
      };
      try {
        const r = await send();
        assert.equal(r.status, 503, 'the seat answers unavailable without sending to qb');
        assert.equal(readEvents(logPath).length, 0, 'an armed hop that never sends writes no event');
      } finally {
        am.admit = origAdmit;
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OPEN_FAILED: an uncreatable log path disables the writer with a seeded open_failed; requests are served', async () => {
  const dir = tmpdir();
  try {
    const blocker = join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const logPath = join(blocker, 'attempts.jsonl');
    let qaSpent = false;
    const policies = [root('amy', 'amy-key', 'force', 'r_one')];
    await withGateway({
      attemptsLog: logPath,
      policies,
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send, control }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      assert.equal((await send()).status, 200, 'the hop is served normally despite the broken log path');
      const telemetry = (await control('/teamclaude/status')).json.continuationTelemetry;
      assert.equal(telemetry.ok, false);
      assert.equal(telemetry.lastError, 'open_failed');
      assert.match(telemetry.lastErrorAt, ISO_MS);
      assert.equal(telemetry.events, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DISABLED: continuationAttemptsLog unset records nothing and reports the clean default', async () => {
  let qaSpent = false;
  const policies = [root('amy', 'amy-key', 'force', 'r_one')];
  await withGateway({
    policies,
    handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
  }, async ({ send, control }) => {
    assert.equal((await send()).status, 200);
    qaSpent = true;
    assert.equal((await send()).status, 200, 'the hop still happens');
    assert.deepEqual((await control('/teamclaude/status')).json.continuationTelemetry,
      { ok: true, lastError: null, lastErrorAt: null, events: 0 });
  });
});

test('ADMIN_ONLY: continuationTelemetry is in the operator status only, never a client key\'s', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    let qaSpent = false;
    const policies = [root('amy', 'amy-key', 'force', 'r_one')];
    await withGateway({
      attemptsLog: logPath,
      policies,
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send, control }) => {
      assert.equal((await send()).status, 200);
      qaSpent = true;
      assert.equal((await send()).status, 200);
      const admin = (await control('/teamclaude/status')).json;
      assert.deepEqual(admin.continuationTelemetry, { ok: true, lastError: null, lastErrorAt: null, events: 1 });
      const amy = (await control('/teamclaude/status', KEYS.amy)).json;
      assert.ok(!('continuationTelemetry' in amy), 'a client key never reads the telemetry');
      assert.ok(!('continuationTelemetry' in (amy.caller ?? {})), 'and never in its caller view');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('event fields are truncated to 128 chars at build time', async () => {
  const dir = tmpdir();
  try {
    const logPath = join(dir, 'attempts.jsonl');
    const longName = 'x'.repeat(200);
    const longKey = 'long-key';
    let qaSpent = false;
    await withGateway({
      attemptsLog: logPath,
      clientKeys: [{ name: longName, key: longKey }],
      routes: [{ name: 'w1+w2+w3', clients: [longName], accounts: ['qa', 'qb', 'qc'] }],
      handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)),
    }, async ({ send }) => {
      const longModel = `claude-opus-4-1-${'y'.repeat(200)}`;
      assert.equal((await send({ key: longKey, model: longModel, policy: '*=force' })).status, 200);
      qaSpent = true;
      assert.equal((await send({ key: longKey, model: longModel, policy: '*=force' })).status, 200);
      const events = readEvents(logPath);
      assert.equal(events.length, 1);
      assert.equal(events[0].client, 'x'.repeat(128));
      assert.equal(events[0].model, longModel.slice(0, 128));
      assert.ok(Buffer.byteLength(JSON.stringify(events[0])) < 4096);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── startup directory mode ───────────────────────────────────────────────────

test('startup: a log directory created under umask 0o077 is chmod 0755 so the console can traverse it', async () => {
  const dir = tmpdir();
  const oldUmask = process.umask(0o077);
  try {
    const logPath = join(dir, 'fresh-subdir', 'attempts.jsonl');
    await withGateway({ attemptsLog: logPath }, async ({ send }) => {
      assert.equal((await send()).status, 200);
    });
    assert.equal(fs.statSync(join(dir, 'fresh-subdir')).mode & 0o777, 0o755, 'the created directory is traversable despite the umask');
  } finally {
    process.umask(oldUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup: EVERY created level of a multi-level log directory is chmod 0755, not just the leaf', async () => {
  const dir = tmpdir();
  const oldUmask = process.umask(0o077);
  try {
    const logPath = join(dir, 'level-one', 'level-two', 'attempts.jsonl');
    await withGateway({ attemptsLog: logPath }, async ({ send }) => {
      assert.equal((await send()).status, 200);
    });
    assert.equal(fs.statSync(join(dir, 'level-one')).mode & 0o777, 0o755, 'an intermediate created directory is traversable too — a leaf-only chmod would leave it 0700 under this umask');
    assert.equal(fs.statSync(join(dir, 'level-one', 'level-two')).mode & 0o777, 0o755);
  } finally {
    process.umask(oldUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── MITM CONNECT tunnel (shape from continuation-policies-mitm.test.js) ──────

const closeHard = (s) => { s?.closeAllConnections?.(); try { s?.close(); } catch { /* closing */ } };
const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');

function connectThroughProxy(proxyPort, target, caCertPem, proxyAuth) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${proxyAuth}\r\n\r\n`,
    ));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(status)); return; }
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['h2'] }, () => resolve(sock));
      sock.once('error', reject);
    };
    raw.on('data', onData);
  });
}

test('MITM: a force hop through a CONNECT tunnel records the event — the continuationTelemetry pass-through is load-bearing', { timeout: 30000 }, async () => {
  const dir = tmpdir();
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const seen = [];
  const state = { spent: false };
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = String(req.headers.authorization || '').replace(/^Bearer TOKEN-/, '');
    seen.push(who);
    if (state.spent && who === 'sa') return spent(res);
    ok(res);
  });
  const upPort = await listen(upstream);
  const quietLog = console.log;
  console.log = () => {};
  const am = new AccountManager(
    [{ name: 'sa', type: 'oauth', accessToken: 'TOKEN-sa', refreshToken: 'r', expiresAt: Date.now() + HOUR },
     { name: 'sc', type: 'oauth', accessToken: 'TOKEN-sc', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
    {
      clientRoutes: [{ name: 's1+s2', clients: ['ana'], accounts: ['sa', 'sc'] }],
      continuationPolicies: [{ client: 'ana', keyHash: keyHashOf('ana-key'), mode: 'force', revision: 'r_mitm' }],
    },
  );
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }], requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
    mitm: { http1Only: false },
  };
  // The writer createProxyServer would build and hand the connect handler;
  // created directly here so the test owns the path.
  const logPath = join(dir, 'attempts.jsonl');
  const telemetry = createContinuationTelemetry({ path: logPath });
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {}, continuationTelemetry: telemetry }));
  const mitmPort = await listen(mitm);
  const viaTunnel = async (session) => {
    const sock = await connectThroughProxy(mitmPort, `127.0.0.1:${upPort}`, caCertPem, basic(':ana-key'));
    const client = http2.connect('https://localhost', { createConnection: () => sock });
    try {
      const req = client.request({
        ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json',
        'x-claude-code-session-id': session,
      });
      let status = 0;
      req.on('response', (h) => { status = Number(h[':status']); });
      req.resume();
      req.end('{"model":"claude-opus-4-1","messages":[{"role":"user","content":"hello"}]}');
      await once(req, 'close');
      return { status };
    } finally {
      client.close();
      sock.destroy();
    }
  };
  try {
    assert.equal((await viaTunnel('tun-1')).status, 200);
    state.spent = true;
    assert.equal((await viaTunnel('tun-1')).status, 200, 'the root force-hopped inside the tunnel');
    assert.deepEqual(seen, ['sa', 'sa', 'sc']);
    const events = readEvents(logPath);
    assert.equal(events.length, 1, 'exactly one continuation event from the tunnelled hop');
    const ev = events[0];
    assert.deepEqual(Object.keys(ev), T1_KEYS);
    assert.equal(ev.mode, 'force');
    assert.equal(ev.hop, 1);
    assert.equal(ev.from, 'sa');
    assert.equal(ev.to, 'sc');
    assert.equal(ev.source, 'root');
    assert.equal(ev.revision, 'r_mitm');
    assert.equal(ev.client, 'ana');
    assert.equal(ev.keyRef, offerKeyRef(keyHashOf('ana-key')), 'the CONNECT-time keyHash derives the C9 keyRef');
    assert.deepEqual(telemetry.status(), { ok: true, lastError: null, lastErrorAt: null, events: 1 });
  } finally {
    console.log = quietLog;
    closeHard(mitm);
    closeHard(upstream);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
