import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { recordSeatRejection, seatVerdict } from '../src/client-routes.js';

// The seat queue (IPM fork): a multi-account seat is a queue of accounts,
// most free space first while handoffBeforeSwitch is on (equal room, e.g. no
// readings yet, keeps config order), config order when it is off. A pinned
// conversation whose account runs out continues on the next account in the
// same request, cold, under both policies (AI-2049). When that continuation is
// refused (the key stops being current mid-request), the answer is the offer:
// the choices (continue cold, start a new conversation, or wait for the reset)
// and the disclosed cold-cache continuation the next prompt confirms.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));

const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key', carol: 'carol-key' };
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

// amy and carol → s1+s2+s3 (qa, qb, then qc); ben → seat-r (qr, outside that route).
const ROUTES = [
  { name: 's1+s2+s3', clients: ['amy', 'carol'], accounts: ['qa', 'qb', 'qc'] },
  { name: 'seat-r', clients: ['ben'], accounts: ['qr'] },
];

const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
const ok = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(okBody);
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

async function withGateway({ handler = (_who, res) => ok(res), config: extra = {} } = {}, fn) {
  const seen = [];
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    attempts.push({ who, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(who, res);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb'), oauth('qc'), oauth('qr')], 0.98, {
    clientRoutes: ROUTES,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
    ...extra,
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  // One turn of one conversation: the body identifies the conversation, so
  // `text` distinguishes conversations under one session id.
  const send = async ({ key = KEYS.amy, session = 's-1', text = 'hello', policy, order, advisor } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-claude-code-session-id': session,
        ...(policy === undefined ? {} : { 'x-teamclaude-seat-policy': policy }),
        ...(order === undefined ? {} : { 'x-teamclaude-seat-order': order }),
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        ...(advisor ? { tools: [{ type: 'advisor_20260301', name: 'advisor', model: advisor }] } : {}),
        messages: [{ role: 'user', content: text }],
      }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* SSE and other non-JSON responses stay raw */ }
    return { status: res.status, headers: res.headers, raw, json };
  };
  try {
    await fn({ send, seen, attempts, am, config });
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

test('with no readings, fresh conversations keep the queue head: equal room keeps config order', async () => {
  await withGateway({}, async ({ send, seen }) => {
    for (const text of ['conv one', 'conv two', 'conv three']) {
      assert.equal((await send({ text })).status, 200);
    }
    assert.deepEqual([...new Set(seen)], ['qa'], `fresh conversations spread: ${JSON.stringify(seen)}`);
  });
});

const offerRecords = (am) => [...am.sessionTracker.sessions.values()].flatMap((s) => [...s.seatContinuations.values()]);

test('a recommend pin that runs out continues cold on the sibling in the same request, with the identical body', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, attempts, am }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa']);

    qaSpent = true;
    const continued = await send({ text: 'hello' });
    assert.equal(continued.status, 200);
    assert.equal(continued.raw, okBody, 'the successful assistant body is unchanged');
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
    assert.equal(attempts[1].body, attempts[2].body, 'the continuation changed the conversation body');
    assert.equal(offerRecords(am).length, 0, 'no offer is recorded when the continuation runs');

    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb'], 'the conversation did not stay on its new pin');

    const fresh = await send({ text: 'a new conversation' });
    assert.equal(fresh.status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb', 'qb']);
  });
});

test('a recommend continuation refused mid-request (key no longer current) offers the choices; the next prompt takes it', async () => {
  let qaSpent = false;
  let revoke = null;
  const handler = (who, res) => {
    if (who === 'qa' && qaSpent) {
      revoke?.();
      spent(res);
      return;
    }
    ok(res);
  };
  await withGateway({ handler }, async ({ send, seen, config }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa']);

    qaSpent = true;
    const orig = config.proxy.clientKeys;
    revoke = () => { revoke = null; config.proxy.clientKeys = []; };
    const stopped = await send({ text: 'hello' });
    config.proxy.clientKeys = orig;
    assert.equal(stopped.status, 429);
    assert.equal(stopped.json?.error?.type, 'rate_limit_error');
    const msg = stopped.json?.error?.message ?? '';
    assert.ok(msg.startsWith('You can keep working by moving to another assigned account; "qb" appears available. The account "qa", pinned to this conversation, cannot serve this request because its quota is exhausted until '), msg);
    assert.ok(!msg.includes('/ipm:handoff'), `a handoff after the limit would confirm the continuation: ${msg}`);
    assert.ok(msg.includes('start a new conversation'), `the fresh-conversation choice is missing: ${msg}`);
    assert.ok(msg.includes('wait for "qa" to reset at '), `the reset choice is missing: ${msg}`);
    assert.ok(msg.includes('reprocess the full conversation at full input-token cost'), `the cold-cache cost is not disclosed: ${msg}`);
    assert.ok(msg.includes('next prompt confirms'), `the continuation is not disclosed: ${msg}`);
    assert.equal(stopped.headers.get('anthropic-ratelimit-unified-7d-reset'), null, 'the offer must not become the generic plan-limit banner');
    assert.deepEqual(seen, ['qa', 'qa'], `a refused continuation leaked to the sibling: ${JSON.stringify(seen)}`);

    const continued = await send({ text: 'hello' });
    assert.equal(continued.status, 200);
    assert.equal(continued.raw, okBody, 'the successful assistant body is unchanged');
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb'], `the disclosed continuation did not reach qb: ${JSON.stringify(seen)}`);

    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb'], 'the conversation did not stay on its new pin');
  });
});

test('a continuation requires the next account to serve the advisor model too', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, am }) => {
    Object.assign(am.accounts[1].quota, {
      unified7dFable: 1,
      unified7dFableReset: Date.now() + HOUR,
      unified7dFableSeenAt: Date.now(),
    });
    recordSeatRejection(am.accounts[1], {
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-reset': sec(Date.now() + HOUR),
    }, 'claude-fable-5');
    assert.ok(seatVerdict(am, am.accounts[1], 'claude-opus-4-1', 'claude-fable-5'), 'qb is spent for the advisor');
    assert.equal(am.unavailableReason(am.accounts[1], 'claude-opus-4-1', 'claude-fable-5'), 'advisor-quota');
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const continued = await send({ text: 'hello', advisor: 'claude-fable-5' });
    assert.equal(continued.status, 200);
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true', 'the advisor-ineligible qb was chosen');
  });
});

test('a recorded rejection moves another conversation pre-send, without sending it to the spent account', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'first' })).status, 200);
    assert.equal((await send({ text: 'second' })).status, 200);
    qaSpent = true;
    assert.equal((await send({ text: 'second' })).status, 200, 'the second conversation records the rejection upstream and continues');
    assert.deepEqual(seen, ['qa', 'qa', 'qa', 'qb']);

    const moved = await send({ text: 'first' });
    assert.equal(moved.status, 200, 'the first conversation continues on its own pre-send');
    assert.equal(moved.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qa', 'qb', 'qb'], 'the recorded rejection went upstream again');
  });
});

test('a quota failure on the recommend destination continues on the third account in the same request', async () => {
  let qaSpent = false;
  let qbSpent = false;
  await withGateway({ handler: (who, res) => ((who === 'qa' && qaSpent) || (who === 'qb' && qbSpent) ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    qbSpent = true;
    const walked = await send({ text: 'hello' });
    assert.equal(walked.status, 200);
    assert.equal(walked.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc', 'qc'], 'the conversation did not stay on qc');
  });
});

test('another client with the same session and opening cannot consume the continuation offer', async () => {
  let qaSpent = false;
  let revoke = null;
  const handler = (who, res) => {
    if (who === 'qa' && qaSpent) { revoke?.(); spent(res); return; }
    ok(res);
  };
  await withGateway({ handler }, async ({ send, seen, am, config }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const orig = config.proxy.clientKeys;
    revoke = () => { revoke = null; config.proxy.clientKeys = []; };
    assert.equal((await send({ text: 'hello' })).status, 429, 'the refused continuation records amy\'s offer');
    config.proxy.clientKeys = orig;
    assert.equal(offerRecords(am).length, 1);
    const other = await send({ key: KEYS.carol, text: 'hello' });
    assert.equal(other.status, 200, 'the other client continues on its own');
    assert.equal(offerRecords(am).length, 1, 'the other client consumed amy\'s offer');
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.ok(seen.every((who) => ['qa', 'qb', 'qc'].includes(who)), `an unassigned account was used: ${JSON.stringify(seen)}`);
  });
});

test('force retries the first upstream quota failure on the sibling with the identical body', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, attempts }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const forced = await send({ text: 'hello', policy: '*=recommend,s1=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.raw, okBody);
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
    assert.equal(attempts[1].body, attempts[2].body, 'force changed the conversation body');
    assert.equal(attempts[2].headers['x-teamclaude-seat-policy'], undefined, 'the policy header reached upstream');
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb'], 'force did not leave the conversation pinned to qb');
  });
});

test('force preserves a successful SSE response byte-for-byte', async () => {
  let qaSpent = false;
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n'
    + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\n'
    + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  await withGateway({ handler: (who, res) => {
    if (who === 'qa' && qaSpent) { spent(res); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  } }, async ({ send }) => {
    const first = await send({ text: 'hello' });
    assert.equal(first.raw, sse);
    qaSpent = true;
    const forced = await send({ text: 'hello', policy: 's1=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.raw, sse, 'the continuation changed the SSE bytes');
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
  });
});

test('pre-send force does not consume an older recommend offer', async () => {
  let qaSpent = false;
  let revoke = null;
  const handler = (who, res) => {
    if (who === 'qa' && qaSpent) { revoke?.(); spent(res); return; }
    ok(res);
  };
  await withGateway({ handler }, async ({ send, seen, am, config }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const orig = config.proxy.clientKeys;
    revoke = () => { revoke = null; config.proxy.clientKeys = []; };
    assert.equal((await send({ text: 'hello' })).status, 429, 'the refused recommend continuation records the offer');
    config.proxy.clientKeys = orig;
    am.sessionTracker.takeSeatContinuation = () => { throw new Error('force consumed the old offer'); };
    assert.equal((await send({ text: 'hello', policy: 's1=force' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

test('mixed policies: a recommend destination that runs out continues on its own too', async () => {
  let qaSpent = false;
  let qbSpent = false;
  await withGateway({ handler: (who, res) => ((who === 'qa' && qaSpent) || (who === 'qb' && qbSpent) ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    const policy = '*=recommend,s1=force,s2=recommend,s3=force';
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    qbSpent = true;
    const walked = await send({ text: 'hello', policy });
    assert.equal(walked.status, 200);
    assert.equal(walked.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
  });
});

test('all-force walks only the assigned route and preserves every body', async () => {
  let qaSpent = false;
  let qbSpent = false;
  await withGateway({ handler: (who, res) => ((who === 'qa' && qaSpent) || (who === 'qb' && qbSpent) ? spent(res) : ok(res)) }, async ({ send, seen, attempts }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    qbSpent = true;
    const forced = await send({ text: 'hello', policy: '*=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
    assert.ok(attempts.every(a => a.body === attempts[0].body), 'a force hop changed the body');
    assert.ok(!seen.includes('qr'), 'an unassigned account was used');
  });
});

test('non-quota failures stay on the bound account and internal headers cannot be spoofed', async () => {
  let fail = false;
  await withGateway({ handler: (who, res) => {
    if (who === 'qa' && fail) {
      res.writeHead(500, { 'content-type': 'application/json', 'x-teamclaude-seat-failover': 'spoof', 'x-teamclaude-seat-policy': 'spoof' });
      res.end('{"type":"error","error":{"type":"api_error","message":"no"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-teamclaude-seat-failover': 'spoof', 'x-teamclaude-seat-policy': 'spoof' });
    res.end(okBody);
  } }, async ({ send, seen }) => {
    const first = await send({ text: 'hello' });
    assert.equal(first.headers.get('x-teamclaude-seat-failover'), null);
    assert.equal(first.headers.get('x-teamclaude-seat-policy'), null);
    fail = true;
    const failed = await send({ text: 'hello', policy: '*=force' });
    assert.equal(failed.status, 500);
    assert.deepEqual(seen, ['qa', 'qa'], 'a 500 moved a force conversation to another account');
  });
});

test('a bound credential failure is a seat error, not a login failure or a sibling hop', async () => {
  let denied = false;
  await withGateway({ handler: (who, res) => {
    if (who === 'qa' && denied) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"permission_error","message":"denied"}}');
    } else ok(res);
  } }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    denied = true;
    const failed = await send({ text: 'hello', policy: '*=force' });
    assert.equal(failed.status, 503);
    assert.match(failed.json?.error?.message ?? '', /seat "s1\+s2\+s3" is unavailable/);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('a single-account seat is unchanged: spent is a hard stop with no queue hint', async () => {
  await withGateway({ handler: (_who, res) => spent(res) }, async ({ send }) => {
    const r = await send({ key: KEYS.ben });
    assert.equal(r.status, 429);
    const msg = r.json?.error?.message ?? '';
    assert.ok(msg.includes('out of quota'), msg);
    assert.ok(!msg.includes('pinned to'), `a single-seat stop must not name a queue: ${msg}`);
    const forced = await send({ key: KEYS.ben, policy: '*=force' });
    assert.equal(forced.status, 429, 'force cannot invent a sibling for a single-account route');
    assert.ok(forced.headers.get('anthropic-ratelimit-unified-7d-reset'), 'the ordinary spent headers are retained');
  });
});

/** Weekly readings, as if upstream had reported them. @param {any} am @param {Record<number, number>} byIndex */
const weekly = (am, byIndex) => {
  for (const [i, u] of Object.entries(byIndex)) Object.assign(am.accounts[Number(i)].quota, { unified7d: u, unified7dReset: Date.now() + 48 * HOUR });
};

test('the recommend continuation goes to the account with the most free space', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, am }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    weekly(am, { 1: 0.8, 2: 0.1 });
    qaSpent = true;
    const continued = await send({ text: 'hello' });
    assert.equal(continued.status, 200);
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qc']);
  });
});

test('force hops to the account with the most free space', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, am }) => {
    assert.equal((await send({ text: 'hello', policy: '*=recommend,s1=force' })).status, 200);
    weekly(am, { 1: 0.8, 2: 0.1 });
    qaSpent = true;
    const forced = await send({ text: 'hello', policy: '*=recommend,s1=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qc']);
  });
});

test('handoffBeforeSwitch off: the continuation keeps config order', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)), config: { handoffBeforeSwitch: false } }, async ({ send, seen, am }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    weekly(am, { 1: 0.8, 2: 0.1 });
    qaSpent = true;
    const continued = await send({ text: 'hello' });
    assert.equal(continued.status, 200);
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

// The seat priority queue (x-teamclaude-seat-order): the caller's preference
// among its own route's accounts. Route s1+s2+s3 is qa, qb, qc.

test('seat order: a new conversation starts on the first listed account, and the header never reaches upstream', async () => {
  await withGateway({}, async ({ send, seen, attempts }) => {
    assert.equal((await send({ text: 'one', order: 's3,s1' })).status, 200);
    assert.equal((await send({ text: 'one', order: 's3,s1' })).status, 200);
    assert.deepEqual(seen, ['qc', 'qc']);
    assert.equal(attempts[0].headers['x-teamclaude-seat-order'], undefined, 'the order header reached upstream');
  });
});

test('seat order: a listed account past a handoff threshold yields to the next listed one with room', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    weekly(am, { 0: 0.5, 1: 0.1, 2: 0.95 });
    assert.equal((await send({ text: 'one', order: 's3,s1' })).status, 200);
    assert.deepEqual(seen, ['qa'], 'qc is past 90% weekly; qa is listed next, ahead of the freer qb');
  });
});

test('seat order: when the first listed account is spent, the recommend continuation goes to the next listed one', async () => {
  let qcSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qc' && qcSpent ? spent(res) : ok(res)) }, async ({ send, seen, am }) => {
    assert.equal((await send({ order: 's3,s1' })).status, 200);
    weekly(am, { 0: 0.5, 1: 0.1 });
    qcSpent = true;
    const continued = await send({ order: 's3,s1' });
    assert.equal(continued.status, 200);
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qc;to=qa;cold-cache=true');
    assert.deepEqual(seen, ['qc', 'qc', 'qa']);
  });
});

test('seat order: force hops to the next listed account', async () => {
  let qcSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qc' && qcSpent ? spent(res) : ok(res)) }, async ({ send, seen, am }) => {
    const headers = { order: 's3,s1', policy: '*=force' };
    assert.equal((await send(headers)).status, 200);
    weekly(am, { 0: 0.5, 1: 0.1 });
    qcSpent = true;
    const forced = await send(headers);
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qc;to=qa;cold-cache=true');
    assert.deepEqual(seen, ['qc', 'qc', 'qa']);
  });
});

test('seat order: a stale slug and another route\'s seat are skipped, never served', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ text: 'one', order: 'gone,s2' })).status, 200);
    assert.equal((await send({ text: 'two', order: 'seat-r' })).status, 200);
    assert.equal((await send({ text: 'three', order: 'seat-r,s3' })).status, 200);
    assert.deepEqual(seen, ['qb', 'qa', 'qc'], 'seat-r (qr) is ben\'s route');
  });
});

test('seat order: a malformed header is ignored whole', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ text: 'one', order: 's3,,s1' })).status, 200);
    assert.equal((await send({ text: 'two', order: ['s3', ...Array.from({ length: 64 }, (_, i) => `x${i}`)].join(',') })).status, 200);
    assert.equal((await send({ text: 'three', order: 's3,s3' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qa']);
  });
});

test('seat order: a pinned conversation is not moved by a change of order', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ order: 's2' })).status, 200);
    assert.equal((await send({ order: 's3' })).status, 200);
    assert.equal((await send({})).status, 200);
    assert.deepEqual(seen, ['qb', 'qb', 'qb']);
  });
});

test('seat order, handoffBeforeSwitch off: the listed accounts first, then config order', async () => {
  let qcSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qc' && qcSpent ? spent(res) : ok(res)), config: { handoffBeforeSwitch: false } }, async ({ send, seen, am }) => {
    weekly(am, { 0: 0.1, 1: 0.95 });
    assert.equal((await send({ order: 's3,s2' })).status, 200);
    qcSpent = true;
    const continued = await send({ order: 's3,s2' });
    assert.equal(continued.status, 200);
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qc;to=qb;cold-cache=true', 'qb is listed next; config order would pick qa');
    assert.deepEqual(seen, ['qc', 'qc', 'qb']);
  });
});
