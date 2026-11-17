#!/usr/bin/env node
// Synthetic verification for AI-1902 (owner-root spent-seat continuation),
// parameterised for a main build and a rollback build (AI-2026).
//
// Runs the REAL teamclaude CLI (`src/index.js server --headless --activity-log`)
// of each build against a local mock Anthropic upstream, with fake OAuth seats
// and fake client keys. Nothing leaves 127.0.0.1:
//   - every seat's upstream is the mock on 127.0.0.1
//   - upstreamProxy + HTTP(S)_PROXY point at a local tripwire that logs and
//     refuses any outbound attempt (profile/usage/refresh/reset/npm)
//   - an `ss` sampler records any non-loopback socket the proxy pid opens
//
// Plan: A main -> B rollback -> C main, one config file for every boot.
//
// Usage:
//   node scripts/synth/ai1902-synth.mjs
// Env overrides:
//   TC_MAIN      the build under test (default: this checkout)
//   TC_ROLLBACK  the rollback build (default: ~/.cache/ai-2026-upstream-1-1-30/tc-ipm24,
//                a detached worktree of v1.1.26-ipm.24)
//   SYNTH_OUT    the evidence root (default: ~/.cache/ai-2026-upstream-1-1-30/synth);
//                each run writes <SYNTH_OUT>/<timestamp>/
// Exits 1 when any check fails.

import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = join(homedir(), '.cache', 'ai-2026-upstream-1-1-30');
const TC = {
  main: process.env.TC_MAIN || fileURLToPath(new URL('../..', import.meta.url)),
  rollback: process.env.TC_ROLLBACK || join(CACHE, 'tc-ipm24'),
};
const OUT = join(process.env.SYNTH_OUT || join(CACHE, 'synth'), new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(OUT, { recursive: true });
const CONFIG_PATH = join(OUT, 'config.json'); // the ONE config file every phase runs
const MODEL = 'claude-opus-4-1';
const HOUR = 3600_000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hex = (n) => randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const line = a.join(' '); console.log(line); appendFileSync(join(OUT, 'run.log'), line + '\n'); };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// ── fake identities ─────────────────────────────────────────────────────────
// Client keys in the production shape (sk-ipm-<48 hex>), all made up here.
const OWNERS = {
  force: { client: 'synth-force', key: `sk-ipm-${hex(24)}` },
  rec: { client: 'synth-rec', key: `sk-ipm-${hex(24)}` },
  legacy: { client: 'synth-legacy', key: `sk-ipm-${hex(24)}` },
  worker: { client: 'synth-worker', key: `sk-ipm-${hex(24)}` },
  cap: { client: 'synth-cap', key: `sk-ipm-${hex(24)}` },
};
const ADMIN_KEY = `sk-admin-${hex(24)}`;
const ROUTE_SEATS = {
  force: ['f1', 'f2'],
  rec: ['r1', 'r2'],
  legacy: ['l1', 'l2'],
  worker: ['wa', 'wb'],
  cap: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'],
};
const SEATS = Object.values(ROUTE_SEATS).flat().map((slug) => ({
  slug,
  name: `${slug}@synth.invalid`,
  accessToken: `sk-ant-oat01-FAKE-${slug}-${hex(20)}`,
  refreshToken: `sk-ant-ort01-FAKE-${slug}-${hex(20)}`,
}));
const seatByToken = new Map(SEATS.map((s) => [s.accessToken, s.slug]));
const seatName = (slug) => `${slug}@synth.invalid`;
// Revision in the renderer's shape: r_ + 22 [A-Za-z0-9_-].
const rev = () => 'r_' + randomBytes(16).toString('base64url').slice(0, 22);
const POLICIES = [
  { client: OWNERS.force.client, keyHash: sha256(OWNERS.force.key), mode: 'force', revision: rev(), quarantine: false },
  { client: OWNERS.rec.client, keyHash: sha256(OWNERS.rec.key), mode: 'recommend', revision: rev(), quarantine: false },
  { client: OWNERS.worker.client, keyHash: sha256(OWNERS.worker.key), mode: 'recommend', revision: rev(), quarantine: false },
  { client: OWNERS.cap.client, keyHash: sha256(OWNERS.cap.key), mode: 'force', revision: rev(), quarantine: false },
  // OWNERS.legacy deliberately has no root.
];

// Worker identity exactly as cg.sh _cg_worker_id_value derives it:
// w1_ + first 32 hex of SHA-256("teamclaude-worker-v1" NUL keyHash NUL CG_WORKER_ID).
const workerIdFor = (key, cgWorkerId) => 'w1_' + sha256(`teamclaude-worker-v1\0${sha256(key)}\0${cgWorkerId}`).slice(0, 32);
const CG_WORKER_IDS = ['laptop-pane-1', 'umbrel-remote-2'];
const W = CG_WORKER_IDS.map((id) => workerIdFor(OWNERS.worker.key, id));
const W_INVALID = 'w1_' + 'Z'.repeat(32);

// ── tripwire: any outbound attempt through a proxy is logged and refused ────
const tripwireHits = [];
const tripwire = http.createServer((req, res) => {
  tripwireHits.push({ at: new Date().toISOString(), kind: 'request', method: req.method, url: req.url });
  res.writeHead(403); res.end('synth tripwire: egress refused');
});
tripwire.on('connect', (req, sock) => {
  tripwireHits.push({ at: new Date().toISOString(), kind: 'CONNECT', target: req.url });
  sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});

// ── mock Anthropic upstream ─────────────────────────────────────────────────
const spent = new Set();
let upstreamAttempts = [];
const resetAt = () => Math.floor((Date.now() + 5 * 24 * HOUR) / 1000);
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const seat = seatByToken.get(token) ?? `unknown(${req.headers['x-api-key'] ? 'x-api-key' : 'no-auth'})`;
  let body = null;
  try { body = JSON.parse(raw); } catch { /* not JSON */ }
  const sysText = JSON.stringify(body?.system ?? '');
  const reqId = (sysText.match(/\[req:([a-z0-9-]+)\]/) || [])[1] ?? null;
  const attempt = { at: Date.now(), seat, reqId, method: req.method, url: req.url, headers: req.headers, stream: !!body?.stream, outcome: null };
  upstreamAttempts.push(attempt);
  if (spent.has(seat)) {
    attempt.outcome = 429;
    res.writeHead(429, {
      'content-type': 'application/json',
      'request-id': `req_synth_${hex(8)}`,
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.40',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 2 * HOUR) / 1000)),
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-utilization': '1.0',
      'anthropic-ratelimit-unified-7d-reset': String(resetAt()),
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-reset': String(resetAt()),
      'x-should-retry': 'false',
    });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account\'s rate limit. Please try again later.' } }));
    return;
  }
  attempt.outcome = 200;
  const quota = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.10',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 2 * HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.50',
    'anthropic-ratelimit-unified-7d-reset': String(resetAt()),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'request-id': `req_synth_${hex(8)}`,
  };
  const message = {
    id: `msg_synth_${hex(8)}`, type: 'message', role: 'assistant', model: body?.model ?? MODEL,
    content: [{ type: 'text', text: `served-by:${seat}` }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  if (body?.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', ...quota });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `served-by:${seat}` } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
    ev('message_stop', {});
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', ...quota });
  res.end(JSON.stringify(message));
});

// ── config (written once; every phase runs this same file) ──────────────────
function writeConfig({ proxyPort, mockPort, tripPort }) {
  const routeName = (k) => ROUTE_SEATS[k].join('+'); // the renderer joins slugs with '+'
  const config = {
    proxy: {
      port: proxyPort,
      host: '127.0.0.1',
      apiKey: ADMIN_KEY,
      clientKeys: Object.values(OWNERS).map((o) => ({ name: o.client, key: o.key })),
      requireClientRoute: true,
    },
    upstream: `http://127.0.0.1:${mockPort}`,
    upstreamProxy: `http://127.0.0.1:${tripPort}`,
    noProxy: '127.0.0.1,localhost',
    // As render-gateway-config.sh writes devs, except quotaProbeSeconds (prod 300):
    // the probe calls api.anthropic.com/api/oauth/usage, so it is off here.
    switchThreshold: { default: 1.0, unified7d: 1.0, unified7dFable: 1.0 },
    quotaProbeSeconds: 0,
    holdSeconds: 0,
    distributeSessions: true,
    eventLogging: 'hide',
    autoUpdate: false,
    accounts: SEATS.map((s) => ({
      name: s.name, type: 'oauth', accessToken: s.accessToken, refreshToken: s.refreshToken,
      expiresAt: Date.now() + 30 * 24 * HOUR,
    })),
    clientRoutes: Object.keys(ROUTE_SEATS).map((k) => ({ name: routeName(k), clients: [OWNERS[k].client], accounts: ROUTE_SEATS[k].map(seatName) })),
    continuationPolicies: POLICIES,
    continuationPolicyErrors: [],
    continuationAttemptsLog: join(OUT, 'continuation-attempts.jsonl'),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── the proxy under test ────────────────────────────────────────────────────
const children = new Set();
function killAll() { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });

async function startProxy(phase, version, proxyPort, tripPort) {
  const home = join(OUT, `home-${phase}`);
  mkdirSync(home, { recursive: true });
  const trip = `http://127.0.0.1:${tripPort}`;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    TEAMCLAUDE_CONFIG: CONFIG_PATH,
    TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
    TEAMCLAUDE_HOST: '127.0.0.1',
    NODE_ENV: 'production',
    HTTPS_PROXY: trip, HTTP_PROXY: trip, https_proxy: trip, http_proxy: trip,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    NODE_USE_ENV_PROXY: '1',
    npm_config_registry: trip,
  };
  const activityLog = join(OUT, `activity-${phase}.log`);
  const child = spawn(process.execPath, [join(TC[version], 'src/index.js'), 'server', '--headless', '--activity-log', activityLog], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const sockets = startSocketSampler(child.pid);
  for (let i = 0; i < 200; i++) {
    if (exited) break;
    try {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, { headers: { 'x-api-key': ADMIN_KEY }, signal: AbortSignal.timeout(1500) });
      if (r.ok) { const j = await r.json(); if (j?.server?.pid === child.pid) break; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  let bound = [];
  try {
    const { execFileSync } = await import('node:child_process');
    bound = execFileSync('ss', ['-tlnpH']).toString().split('\n').filter((l) => l.includes(`pid=${child.pid},`)).map((l) => l.trim().split(/\s+/)[3]);
  } catch { /* ss missing */ }
  return {
    child, pid: child.pid, activityLog, sockets, bound,
    started: !exited,
    exited: () => exited,
    output: () => output,
    stop: async () => {
      sockets.stop();
      if (!exited) {
        child.kill('SIGTERM');
        for (let i = 0; i < 50 && !exited; i++) await sleep(100);
        if (!exited) child.kill('SIGKILL');
      }
      children.delete(child);
      writeFileSync(join(OUT, `proxy-output-${phase}.log`), output);
    },
  };
}

// Any socket of the proxy pid whose peer is not loopback (TCP or UDP, e.g. DNS).
function startSocketSampler(pid) {
  const seen = new Set();
  const listening = new Set();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    execFile('ss', ['-tunapH'], (err, stdout) => {
      if (!err) {
        for (const line of stdout.split('\n')) {
          if (!line.includes(`pid=${pid},`)) continue;
          const cols = line.trim().split(/\s+/);
          const local = cols[4] ?? '';
          const peer = cols[5] ?? '';
          if (/LISTEN/.test(line)) listening.add(local);
          const isLoop = (a) => /^(127\.|\[::1\]|\[::ffff:127\.|\*|0\.0\.0\.0|\[::\])/.test(a);
          if (peer && !isLoop(peer)) seen.add(line.trim());
        }
      }
      setTimeout(tick, 200);
    });
  };
  tick();
  return { stop: () => { stopped = true; }, nonLoopback: () => [...seen], listening: () => [...listening] };
}

// ── client side (emulates what Claude Code + cg put on the wire) ───────────
let proxyPort = 0;
const evidence = []; // every response a client saw, for the leak grep and the report
let phaseName = '';

async function send({ owner, session, opening, turn, stream = false, contract = false, policy, worker, label }) {
  const reqId = `${phaseName}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const messages = [{ role: 'user', content: opening }];
  for (let t = 1; t < turn; t++) {
    messages.push({ role: 'assistant', content: `answer ${t}` });
    messages.push({ role: 'user', content: `follow-up ${t}` });
  }
  // The request tag rides in `system`, outside `messages`: the conversation digest is the raw
  // bytes of messages[0], so tagging a message would make every turn a new conversation.
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': 'claude-cli/2.1.0 (external, cli)',
    'x-api-key': OWNERS[owner].key,
    'x-claude-code-session-id': session,
    ...(contract ? { 'x-teamclaude-cg-contract': 'root-v1' } : {}),
    ...(policy ? { 'x-teamclaude-seat-policy': policy } : {}),
    ...(worker ? { 'x-teamclaude-worker-id': worker } : {}),
  };
  const before = upstreamAttempts.length;
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST', headers, body: JSON.stringify({ model: MODEL, max_tokens: 64, stream, system: `synth harness [req:${reqId}]`, messages }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* SSE or text */ }
  const servedBy = (raw.match(/served-by:([a-z0-9]+)/) || [])[1] ?? null;
  const attempts = upstreamAttempts.filter((a) => a.reqId === reqId).map((a) => `${a.seat}:${a.outcome}`);
  const rec = {
    phase: phaseName, label, reqId, owner, session, turn, worker: worker ?? null, sentContract: contract, sentPolicy: policy ?? null,
    status: res.status, headers: Object.fromEntries(res.headers.entries()), body: raw, message: json?.error?.message ?? null,
    servedBy, upstreamAttempts: attempts, newUpstreamAttempts: upstreamAttempts.length - before,
  };
  evidence.push(rec);
  appendFileSync(join(OUT, 'responses.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}

async function status(key = ADMIN_KEY) {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, { headers: { 'x-api-key': key } });
  const raw = await r.text();
  evidence.push({ phase: phaseName, label: `status:${key === ADMIN_KEY ? 'admin' : 'client'}`, status: r.status, headers: Object.fromEntries(r.headers.entries()), body: raw });
  return JSON.parse(raw);
}

const brief = (r) => `${r.status}${r.servedBy ? ` served-by=${r.servedBy}` : ''} upstream=[${r.upstreamAttempts.join(',')}]${r.headers['x-teamclaude-seat-failover'] ? ` failover=${r.headers['x-teamclaude-seat-failover']}` : ''}`;
const results = [];
function check(id, pass, evidenceLine, extra = {}) {
  results.push({ phase: phaseName, id, pass, evidence: evidenceLine, ...extra });
  log(`  [${pass === true ? 'PASS' : pass === false ? 'FAIL' : pass}] ${id}: ${evidenceLine}`);
}

// ── scenarios ───────────────────────────────────────────────────────────────
// 1. Force root: pinned seat spent -> served by the sibling, no 429 reaches the client.
async function scenarioForce(expectRoot) {
  const s = `force-${phaseName}`;
  const t1 = await send({ owner: 'force', session: s, opening: 'force opening', turn: 1, stream: true, contract: true, label: 'force-t1' });
  spent.add('f1');
  // A conflicting cached legacy header too: under a root it must be ignored.
  const t2 = await send({ owner: 'force', session: s, opening: 'force opening', turn: 2, stream: true, contract: true, policy: '*=recommend', label: 'force-t2' });
  const t3 = await send({ owner: 'force', session: s, opening: 'force opening', turn: 3, stream: true, contract: true, label: 'force-t3' });
  if (expectRoot) {
    check('1 force: hop to sibling, no 429', t1.servedBy === 'f1' && t2.status === 200 && t2.servedBy === 'f2'
      && t2.upstreamAttempts.join() === 'f1:429,f2:200' && t2.headers['x-teamclaude-seat-failover'] === `from=${encodeURIComponent(seatName('f1'))};to=${encodeURIComponent(seatName('f2'))};cold-cache=true`
      && t3.status === 200 && t3.upstreamAttempts.join() === 'f2:200',
    `t1 ${brief(t1)} | spend f1 | t2 (stream, legacy *=recommend header) ${brief(t2)} | t3 ${brief(t3)} (re-pinned, f1 not retried)`);
  } else {
    check('1 force root ignored (pre-root build => legacy recommend)', t2.status === 429 && t2.upstreamAttempts.join() === 'f1:429',
      `t1 ${brief(t1)} | spend f1 | t2 ${brief(t2)} msg="${(t2.message || '').slice(0, 90)}..." | t3 ${brief(t3)}`);
  }
  return { t1, t2, t3 };
}

// 1b. The 8-continuation cap: 10 seats, all spent, force root.
async function scenarioCap(expectRoot) {
  const s = `cap-${phaseName}`;
  const t1 = await send({ owner: 'cap', session: s, opening: 'cap opening', turn: 1, contract: true, label: 'cap-t1' });
  for (const c of ROUTE_SEATS.cap) spent.add(c);
  const t2 = await send({ owner: 'cap', session: s, opening: 'cap opening', turn: 2, contract: true, label: 'cap-t2' });
  const hops = t2.upstreamAttempts.length - 1;
  if (expectRoot) {
    check('1 force: attempts capped at 8 continuations', t1.servedBy === 'c0' && t2.status === 429 && t2.upstreamAttempts.length === 9 && hops === 8
      && !t2.upstreamAttempts.some((a) => a.startsWith('c9')) && /limit of 8 automatic continuations/.test(t2.message || '')
      && t2.headers['x-should-retry'] === 'false' && !t2.headers['anthropic-ratelimit-unified-7d-reset'],
    `10-seat route all spent: ${t2.upstreamAttempts.length} upstream attempts (1 + ${hops} hops, c9 never tried), ${t2.status} x-should-retry=${t2.headers['x-should-retry']} msg="${(t2.message || '').slice(0, 140)}"`);
  } else {
    check('1b cap route under pre-root build', t2.status === 429 ? 'INFO' : 'INFO', `${brief(t2)}`);
  }
  return { t1, t2 };
}

// 2. Recommend root: continuation 429 offer naming the owner-wide cg commands; next prompt accepts.
async function scenarioRecommend(expectRoot) {
  const s = `rec-${phaseName}`;
  const sPlain = `rec-plain-${phaseName}`;
  const t1 = await send({ owner: 'rec', session: s, opening: 'rec opening', turn: 1, contract: true, label: 'rec-t1' });
  const p1 = await send({ owner: 'rec', session: sPlain, opening: 'rec plain opening', turn: 1, label: 'rec-plain-t1' });
  spent.add('r1');
  // A cached legacy force header must not revive force under a recommend root.
  const t2 = await send({ owner: 'rec', session: s, opening: 'rec opening', turn: 2, contract: true, policy: '*=force', label: 'rec-t2-offer' });
  const t3 = await send({ owner: 'rec', session: s, opening: 'rec opening', turn: 3, contract: true, label: 'rec-t3-accept' });
  const p2 = await send({ owner: 'rec', session: sPlain, opening: 'rec plain opening', turn: 2, label: 'rec-plain-t2-no-contract' });
  writeFileSync(join(OUT, `recommend-429-body-${phaseName}.json`), t2.body);
  const msg = t2.message || '';
  const names = msg.includes('`cg seat-policy force`') && msg.includes('`cg seat-policy recommend`');
  if (expectRoot) {
    check('2 recommend: continuation 429 offer', t1.servedBy === 'r1' && t2.status === 429 && t2.upstreamAttempts.join() === 'r1:429'
      && t2.headers['x-should-retry'] === 'false' && !t2.headers['anthropic-ratelimit-unified-status']
      && /next prompt confirms/.test(msg) && /\/ipm:handoff/.test(msg) && /cold prompt cache/.test(msg) && names,
    `t2 ${brief(t2)} x-should-retry=false, no unified headers; body names \`cg seat-policy force\` + \`cg seat-policy recommend\`, /ipm:handoff, cold-cache warning; legacy *=force header did not hop`);
    check('2 recommend: next prompt accepts and continues', t3.status === 200 && t3.servedBy === 'r2' && t3.upstreamAttempts.join() === 'r2:200'
      && /cold-cache=true/.test(t3.headers['x-teamclaude-seat-failover'] || ''),
    `t3 (same conversation, next prompt) ${brief(t3)}`);
    check('2 recommend: no root-v1 contract => no owner-wide paragraph', p2.status === 429 && !(p2.message || '').includes('cg seat-policy'),
      `plain conv t2 without x-teamclaude-cg-contract: ${p2.status}, paragraph absent`);
  } else {
    check('2 recommend under pre-root build', 'INFO', `t2 ${brief(t2)} names-cg-commands=${names}; t3 ${brief(t3)}; p1 ${brief(p1)}`);
  }
  return { t2, t3, p2 };
}

// 3. No root: legacy header behaviour (default recommend; *=force hops).
async function scenarioLegacy() {
  const a = `legacy-a-${phaseName}`;
  const b = `legacy-b-${phaseName}`;
  const a1 = await send({ owner: 'legacy', session: a, opening: 'legacy a', turn: 1, label: 'legacy-a1' });
  const b1 = await send({ owner: 'legacy', session: b, opening: 'legacy b', turn: 1, label: 'legacy-b1' });
  spent.add('l1');
  const a2 = await send({ owner: 'legacy', session: a, opening: 'legacy a', turn: 2, label: 'legacy-a2-offer' });
  const a3 = await send({ owner: 'legacy', session: a, opening: 'legacy a', turn: 3, label: 'legacy-a3-accept' });
  const b2 = await send({ owner: 'legacy', session: b, opening: 'legacy b', turn: 2, policy: '*=force', label: 'legacy-b2-force-header' });
  return { a1, b1, a2, a3, b2 };
}
const legacySignature = (L) => ({
  a1: [L.a1.status, L.a1.servedBy, L.a1.upstreamAttempts.join()],
  b1: [L.b1.status, L.b1.servedBy, L.b1.upstreamAttempts.join()],
  a2: [L.a2.status, L.a2.upstreamAttempts.join(), L.a2.headers['x-should-retry'], (L.a2.message || '').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<ISO>')],
  a3: [L.a3.status, L.a3.servedBy, L.a3.upstreamAttempts.join(), L.a3.headers['x-teamclaude-seat-failover'] ?? null],
  b2: [L.b2.status, L.b2.servedBy, L.b2.upstreamAttempts.join(), L.b2.headers['x-teamclaude-seat-failover'] ?? null],
});

// 4. Worker identity.
async function scenarioWorkers(capabilityOn) {
  const s = `workers-${phaseName}`;
  const op = 'identical worker opening';
  const hdr = (i) => (capabilityOn ? W[i] : undefined); // cg sends the header only when status advertises workerIdentity
  const [x1, y1] = await Promise.all([
    send({ owner: 'worker', session: s, opening: op, turn: 1, contract: capabilityOn, worker: hdr(0), label: 'w1-t1' }),
    send({ owner: 'worker', session: s, opening: op, turn: 1, contract: capabilityOn, worker: hdr(1), label: 'w2-t1' }),
  ]);
  const scopes = capabilityOn ? (await status()).workerScopes ?? null : null;
  spent.add('wa');
  const x2 = await send({ owner: 'worker', session: s, opening: op, turn: 2, contract: capabilityOn, worker: hdr(0), label: 'w1-t2' });
  const y2 = await send({ owner: 'worker', session: s, opening: op, turn: 2, contract: capabilityOn, worker: hdr(1), label: 'w2-t2' });
  const [x3, y3] = await Promise.all([
    send({ owner: 'worker', session: s, opening: op, turn: 3, contract: capabilityOn, worker: hdr(0), label: 'w1-t3' }),
    send({ owner: 'worker', session: s, opening: op, turn: 3, contract: capabilityOn, worker: hdr(1), label: 'w2-t3' }),
  ]);
  return { x1, y1, x2, y2, x3, y3, scopes };
}
async function scenarioInvalidWorker() {
  const before = upstreamAttempts.length;
  const r = await send({ owner: 'worker', session: `inv-${phaseName}`, opening: 'invalid worker', turn: 1, contract: true, worker: W_INVALID, label: 'invalid-worker' });
  const ok = await send({ owner: 'worker', session: `inv-ok-${phaseName}`, opening: 'after invalid', turn: 1, contract: true, worker: W[0], label: 'after-invalid' });
  return { r, ok, upstreamDelta: upstreamAttempts.length - before };
}

async function snapshotContinuation() {
  const admin = await status();
  const pick = (o) => ({
    capabilities: o.capabilities ?? '(absent)',
    continuationPolicies: o.continuationPolicies ?? '(absent)',
    continuationPolicyErrors: o.continuationPolicyErrors ?? '(absent)',
    continuationPolicyLoadError: o.continuationPolicyLoadError === undefined ? '(absent)' : o.continuationPolicyLoadError,
  });
  const callers = {};
  for (const [k, o] of Object.entries(OWNERS)) {
    const st = await status(o.key);
    callers[k] = st?.caller?.continuationPolicy ?? '(absent)';
  }
  return { version: admin?.server?.version ?? admin?.version ?? null, admin: pick(admin), callers, telemetry: admin.continuationTelemetry ?? '(absent)', workerScopes: admin.workerScopes ?? '(absent)' };
}

// ── phases ──────────────────────────────────────────────────────────────────
async function runPhase(phase, version, ports, opts) {
  phaseName = phase;
  spent.clear();
  upstreamAttempts = [];
  log(`\n=== phase ${phase}: teamclaude ${version} (${TC[version]}) config sha256=${sha256(readFileSync(CONFIG_PATH))}`);
  const proxy = await startProxy(phase, version, ports.proxyPort, ports.tripPort);
  if (!proxy.started) {
    log(`  proxy did not start: ${JSON.stringify(proxy.exited())}\n${proxy.output()}`);
    await proxy.stop();
    return { phase, version, started: false };
  }
  const out = { phase, version, started: true, pid: proxy.pid };
  try {
    out.snapshot = await snapshotContinuation();
    log(`  status: version=${out.snapshot.version} capabilities=${JSON.stringify(out.snapshot.admin.capabilities)} policies=${JSON.stringify(out.snapshot.admin.continuationPolicies)}`);
    log(`  callers: ${JSON.stringify(out.snapshot.callers)}`);
    const hasRoots = out.snapshot.admin.capabilities?.continuationPolicies >= 1;
    const workerCap = out.snapshot.admin.capabilities?.workerIdentity === true;
    out.hasRoots = hasRoots; out.workerCap = workerCap;
    out.force = await scenarioForce(hasRoots);
    out.cap = await scenarioCap(hasRoots);
    out.rec = await scenarioRecommend(hasRoots);
    out.legacy = await scenarioLegacy();
    out.legacySig = legacySignature(out.legacy);
    if (opts.workers) {
      out.workers = await scenarioWorkers(workerCap);
      if (workerCap) out.invalid = await scenarioInvalidWorker();
    }
    out.snapshotAfter = await snapshotContinuation();
    out.upstreamHeaderLeaks = upstreamAttempts.filter((a) => ['x-teamclaude-worker-id', 'x-teamclaude-cg-contract', 'x-teamclaude-seat-policy', 'x-api-key'].some((h) => h in a.headers)).map((a) => ({ reqId: a.reqId, seat: a.seat, hdrs: Object.keys(a.headers).filter((h) => h.startsWith('x-teamclaude') || h === 'x-api-key') }));
    out.upstreamClientKeySeen = upstreamAttempts.some((a) => Object.values(OWNERS).some((o) => JSON.stringify(a.headers).includes(o.key)));
  } finally {
    await proxy.stop();
    out.nonLoopbackSockets = proxy.sockets.nonLoopback();
    out.listening = [...new Set([...proxy.bound, ...proxy.sockets.listening()])];
    out.exit = proxy.exited();
    out.activityLog = existsSync(proxy.activityLog) ? readFileSync(proxy.activityLog, 'utf8') : '';
    out.proxyOutput = proxy.output();
    out.upstreamAttempts = upstreamAttempts.map(({ headers: _headers, ...rest }) => rest);
    writeFileSync(join(OUT, `phase-${phase}.json`), JSON.stringify(out, null, 2));
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
const tripPort = await listen(tripwire);
const mockPort = await listen(mock);
proxyPort = await new Promise((r) => { const p = net.createServer(); p.listen(0, '127.0.0.1', () => { const port = p.address().port; p.close(() => r(port)); }); });
writeConfig({ proxyPort, mockPort, tripPort });
const configAtStart = readFileSync(CONFIG_PATH, 'utf8');
log(`out=${OUT}\nmock=127.0.0.1:${mockPort} tripwire=127.0.0.1:${tripPort} proxy=127.0.0.1:${proxyPort}`);
log(`worker ids: CG_WORKER_ID=${CG_WORKER_IDS.map((id, i) => `${JSON.stringify(id)}->${W[i].slice(0, 7)}…`).join(' ')}`);

const ports = { proxyPort, tripPort };
const phases = [];
const configHashes = [];
log(`main=${TC.main}\nrollback=${TC.rollback}`);
const plan = [
  ['A', 'main', { workers: true }],
  ['B', 'rollback', { workers: true }],
  ['C', 'main', { workers: true }],
];
const configAfter = {};
for (const [phase, version, opts] of plan) {
  configHashes.push({ before: phase, sha256: sha256(readFileSync(CONFIG_PATH)) });
  phases.push(await runPhase(phase, version, ports, opts));
  configAfter[phase] = readFileSync(CONFIG_PATH, 'utf8');
}
// Which leaf paths a boot rewrote (values elided: they include tokens).
function changedPaths(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths(a[k], b[k], `${path}.${k}`));
  }
  return [`${path}${a === undefined ? ' (added)' : b === undefined ? ' (removed)' : ' (changed)'}`];
}
writeFileSync(join(OUT, 'config-rewrites.json'), JSON.stringify(Object.fromEntries(plan.map(([ph], i) => [ph,
  changedPaths(JSON.parse(i === 0 ? configAtStart : configAfter[plan[i - 1][0]]), JSON.parse(configAfter[ph]))])), null, 2));
configHashes.push({ before: 'end', sha256: sha256(readFileSync(CONFIG_PATH)) });

// ── evaluation of checks 3-6 across phases ──────────────────────────────────
phaseName = 'eval';
const P = Object.fromEntries(phases.map((p) => [p.phase, p]));

// 3. Legacy: no root keeps the rollback build's behaviour byte for byte (main A vs rollback B).
{
  const sMain = JSON.stringify(P.A.legacySig, null, 0);
  const sRollback = JSON.stringify(P.B.legacySig, null, 0);
  const L = P.A.legacy;
  const shape = L.a2.status === 429 && L.a2.upstreamAttempts.join() === 'l1:429' && L.a3.servedBy === 'l2' && L.b2.status === 200 && L.b2.servedBy === 'l2' && L.b2.upstreamAttempts.join() === 'l2:200' && /cold-cache=true/.test(L.b2.headers['x-teamclaude-seat-failover'] || '');
  // b2: l1 is already recorded spent (by a2), so the legacy force header moves b straight to l2 with nothing sent to l1.
  check('3 no root: legacy behaviour (main vs rollback trace)', shape && sMain === sRollback,
    `main: a2 ${brief(L.a2)} | a3 ${brief(L.a3)} | b2(*=force) ${brief(L.b2)}; trace identical to the rollback build (statuses, seats, attempts, failover header, timestamp-normalized message): ${sMain === sRollback}`);
  if (sMain !== sRollback) writeFileSync(join(OUT, 'legacy-diff.json'), JSON.stringify({ main: P.A.legacySig, rollback: P.B.legacySig }, null, 2));
  const caller = P.A.snapshot.callers.legacy;
  check('3 no root: status reads legacy', JSON.stringify(caller) === JSON.stringify({ source: 'legacy', mode: null, revision: null }), `caller.continuationPolicy=${JSON.stringify(caller)}`);
}

// 4. Workers.
{
  const w = P.A.workers;
  const isolated = w.x1.status === 200 && w.y1.status === 200 && w.x2.status === 429 && w.y2.status === 429
    && w.y2.upstreamAttempts.length === 0 && w.x3.status === 200 && w.y3.status === 200 && w.x3.servedBy === 'wb' && w.y3.servedBy === 'wb';
  check('4 workers: separate pins/offers', isolated,
    `concurrent t1 W1 ${brief(w.x1)} / W2 ${brief(w.y1)}; workerScopes=${JSON.stringify(w.scopes)}; spend wa; W1 t2 ${brief(w.x2)}; W2 t2 ${brief(w.y2)} (own offer, did NOT take W1's); concurrent t3 W1 ${brief(w.x3)} / W2 ${brief(w.y3)}`);
  const inv = P.A.invalid;
  check('4 invalid worker id', inv.r.status === 400 && inv.upstreamDelta === 1 && inv.ok.status === 200,
    `invalid "w1_Z…": ${inv.r.status} ${inv.r.headers['x-should-retry'] ? `x-should-retry=${inv.r.headers['x-should-retry']} ` : ''}"${inv.r.message}"; 0 upstream attempts for it; next valid request ${brief(inv.ok)}; proxy still up`);
  const capA = P.A.snapshot.admin.capabilities;
  const capClient = P.A.snapshot.callers; // per-client capabilities checked below
  check('4 status capabilities.workerIdentity', capA?.workerIdentity === true, `admin capabilities=${JSON.stringify(capA)}`);
  const leaks = P.A.upstreamHeaderLeaks;
  check('4 headers stripped before upstream', leaks.length === 0 && !P.A.upstreamClientKeySeen,
    `x-teamclaude-worker-id / cg-contract / seat-policy / x-api-key reaching mock upstream in main (A): ${leaks.length}; client key seen upstream: ${P.A.upstreamClientKeySeen}`);
  void capClient;
}

// 5. Secrets in responses, status and logs.
{
  const needles = [];
  for (const o of Object.values(OWNERS)) {
    needles.push([`client key (${o.client})`, o.key]);
    needles.push([`keyHash (${o.client})`, sha256(o.key)]);
  }
  needles.push(['admin key', ADMIN_KEY]);
  for (const s of SEATS) { needles.push([`accessToken ${s.slug}`, s.accessToken]); needles.push([`refreshToken ${s.slug}`, s.refreshToken]); }
  CG_WORKER_IDS.forEach((id, i) => { needles.push([`raw CG_WORKER_ID ${i}`, id]); needles.push([`wire worker id ${i}`, W[i]]); });
  const haystacks = [];
  for (const e of evidence) haystacks.push([`${e.phase}:${e.label}`, JSON.stringify({ status: e.status, headers: e.headers, body: e.body })]);
  for (const p of phases) {
    haystacks.push([`${p.phase}:proxy stdout/stderr`, p.proxyOutput || '']);
    haystacks.push([`${p.phase}:activity log`, p.activityLog || '']);
  }
  const attemptsLog = join(OUT, 'continuation-attempts.jsonl');
  haystacks.push(['continuation-attempts.jsonl', existsSync(attemptsLog) ? readFileSync(attemptsLog, 'utf8') : '']);
  const hits = [];
  for (const [hn, hay] of haystacks) for (const [nn, needle] of needles) if (hay.includes(needle)) hits.push(`${nn} in ${hn}`);
  writeFileSync(join(OUT, 'leak-grep.json'), JSON.stringify({ needles: needles.map(([n]) => n), haystacks: haystacks.map(([h, s]) => [h, s.length]), hits }, null, 2));
  const responseHits = hits.filter((h) => !/proxy stdout|activity log|attempts\.jsonl/.test(h));
  const logHits = hits.filter((h) => /proxy stdout|activity log|attempts\.jsonl/.test(h));
  check('5 no secret in 429s/status/responses', responseHits.length === 0, `${needles.length} needles x ${evidence.length} responses+status bodies across ${phases.length} phases: ${responseHits.length} hits${responseHits.length ? ' ' + responseHits.slice(0, 5).join('; ') : ''}`);
  check('5 no secret in proxy logs', logHits.length === 0, `stdout/stderr + activity log per phase + attempt log (${haystacks.length - evidence.length} files): ${logHits.length} hits${logHits.length ? ' ' + logHits.slice(0, 5).join('; ') : ''}`);
}

// 6. Rollback / roll-forward.
{
  const norm = (s) => JSON.stringify({ admin: s.admin, callers: s.callers });
  const cfgPolicies = (txt) => JSON.stringify(JSON.parse(txt).continuationPolicies);
  const rewrites = JSON.parse(readFileSync(join(OUT, 'config-rewrites.json'), 'utf8'));
  const policyTouched = Object.values(rewrites).flat().filter((p) => /^\.continuationPolic/.test(p));
  const everyBoot = [configAtStart, ...plan.map(([ph]) => configAfter[ph])].map(cfgPolicies);
  check('6 config: continuationPolicies byte-identical across every boot', everyBoot.every((p) => p === everyBoot[0]) && policyTouched.length === 0,
    `continuationPolicies identical at start and after ${plan.map(([ph]) => ph).join(', ')}; sha256: ${configHashes.map((h) => `${h.before}=${h.sha256.slice(0, 12)}`).join(' ')}; boot rewrites by phase: ${JSON.stringify(Object.fromEntries(Object.entries(rewrites).map(([k, v]) => [k, v.length ? [...new Set(v.map((x) => x.replace(/\.accounts\.\d+/, '.accounts[*]')))] : []])))}`);
  check('6 rollback build starts and honours the root', P.B.started && P.B.hasRoots && P.B.force.t2.status === 200 && P.B.force.t2.servedBy === 'f2' && P.B.rec.t2.status === 429 && P.B.rec.t3.servedBy === 'r2' && P.B.cap.t2.upstreamAttempts.length === 9,
    `rollback force t2 ${brief(P.B.force.t2)}; recommend t2 ${P.B.rec.t2.status} -> t3 ${brief(P.B.rec.t3)}; cap ${P.B.cap.t2.upstreamAttempts.length} attempts`);
  check('6 status continuation fields identical A/B/C', norm(P.A.snapshot) === norm(P.B.snapshot) && norm(P.A.snapshot) === norm(P.C.snapshot),
    `A=B: ${norm(P.A.snapshot) === norm(P.B.snapshot)}; A=C: ${norm(P.A.snapshot) === norm(P.C.snapshot)}; policies=${JSON.stringify(P.A.snapshot.admin.continuationPolicies.map((p) => `${p.client}:${p.mode}`))}`);
  check('6 roll-forward after the rollback keeps behaviour', P.C.force.t2.servedBy === 'f2' && P.C.rec.t2.status === 429 && P.C.rec.t3.servedBy === 'r2' && P.C.cap.t2.upstreamAttempts.length === 9,
    `C force t2 ${brief(P.C.force.t2)}, rec t3 ${brief(P.C.rec.t3)}, cap ${P.C.cap.t2.upstreamAttempts.length} attempts`);
}

// Network guard.
{
  const nonLoop = phases.flatMap((p) => p.nonLoopbackSockets.map((s) => `${p.phase}: ${s}`));
  check('guard: no egress', tripwireHits.length === 0 && nonLoop.length === 0,
    `tripwire hits=${tripwireHits.length}${tripwireHits.length ? ' ' + JSON.stringify(tripwireHits.slice(0, 3)) : ''}; non-loopback sockets of proxy pids=${nonLoop.length}; listeners=${[...new Set(phases.flatMap((p) => p.listening))].join(',')}`);
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, configHashes, tripwireHits }, null, 2));
const failed = results.filter((r) => r.pass === false);
log(`\nresults: ${join(OUT, 'results.json')} (${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map((r) => `${r.phase}:${r.id}`).join(', ')}` : ''})`);
tripwire.close(); mock.closeAllConnections?.(); mock.close();
killAll();
process.exit(failed.length ? 1 : 0);
