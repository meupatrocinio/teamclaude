import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { CompactAsks } from '../src/compact-before-switch.js';
import { keyHashOf, recordSeatRejection } from '../src/client-routes.js';
import {
  resolveHandoffBeforeSwitch, decideHandoffBeforeSwitch, handoffAskAnswer, handoffBeforeSwitchStatus,
  handoffWindows, lastMessageIsTypedPrompt, relativeTime, windowLabel, pastHandoffThreshold,
  handoffHeadroom, rankByHeadroom, softDrainIndex, preferSeatOrder,
  DEFAULT_FIVE_HOUR_UTILIZATION, DEFAULT_WEEKLY_UTILIZATION, DEFAULT_MIN_BODY_BYTES, DEFAULT_COOLDOWN_SECONDS,
} from '../src/handoff-before-switch.js';

// handoffBeforeSwitch (IPM fork): a large seat-bound conversation whose pinned
// account is near a quota window is told once, while that account still serves
// it warm, to run /ipm:handoff. The setting, the decision and the answer
// without a server first, then the request path against a stub upstream.

const HOUR = 3600_000;
const MINUTE = 60_000;
const DEFAULTS = { fiveHourUtilization: DEFAULT_FIVE_HOUR_UTILIZATION, weeklyUtilization: DEFAULT_WEEKLY_UTILIZATION, minBodyBytes: DEFAULT_MIN_BODY_BYTES, cooldownMs: DEFAULT_COOLDOWN_SECONDS * 1000 };

// ── the setting ──────────────────────────────────────────────────────────────

test('the setting is on by default and only false turns it off', () => {
  assert.deepEqual(DEFAULTS, { fiveHourUtilization: 0.75, weeklyUtilization: 0.9, minBodyBytes: 200_000, cooldownMs: 1_800_000 });
  for (const raw of [undefined, null, true, {}, 'yes', 1, []]) {
    assert.deepEqual(resolveHandoffBeforeSwitch(raw), DEFAULTS, `${JSON.stringify(raw)} is on with the defaults`);
  }
  assert.equal(resolveHandoffBeforeSwitch(false), null);
});

test('an object tunes each field, and a field that is not a usable number takes its default', () => {
  assert.deepEqual(
    resolveHandoffBeforeSwitch({ fiveHourUtilization: 0.6, weeklyUtilization: 0.8, minBodyBytes: 1000, cooldownSeconds: 60 }),
    { fiveHourUtilization: 0.6, weeklyUtilization: 0.8, minBodyBytes: 1000, cooldownMs: 60_000 },
  );
  for (const v of [0, 1, -0.1, 2, '0.8', NaN, null]) {
    assert.equal(resolveHandoffBeforeSwitch({ fiveHourUtilization: v })?.fiveHourUtilization, DEFAULT_FIVE_HOUR_UTILIZATION, `fiveHourUtilization ${v}`);
    assert.equal(resolveHandoffBeforeSwitch({ weeklyUtilization: v })?.weeklyUtilization, DEFAULT_WEEKLY_UTILIZATION, `weeklyUtilization ${v}`);
  }
  for (const v of [0, -1, '1000', Infinity, null]) {
    assert.equal(resolveHandoffBeforeSwitch({ minBodyBytes: v })?.minBodyBytes, DEFAULT_MIN_BODY_BYTES, `minBodyBytes ${v}`);
    assert.equal(resolveHandoffBeforeSwitch({ cooldownSeconds: v })?.cooldownMs, DEFAULT_COOLDOWN_SECONDS * 1000, `cooldownSeconds ${v}`);
  }
});

test('status reports the setting as resolved and the count asked', () => {
  assert.deepEqual(handoffBeforeSwitchStatus(undefined, null), { enabled: true, fiveHourUtilization: 0.75, weeklyUtilization: 0.9, minBodyBytes: 200_000, cooldownSeconds: 1800, asked: 0 });
  assert.deepEqual(handoffBeforeSwitchStatus(false, { asked: 3 }), { enabled: false, asked: 3 });
  assert.deepEqual(handoffBeforeSwitchStatus({ weeklyUtilization: 0.85, cooldownSeconds: 60 }, { asked: 1 }), { enabled: true, fiveHourUtilization: 0.75, weeklyUtilization: 0.85, minBodyBytes: 200_000, cooldownSeconds: 60, asked: 1 });
});

// ── the decision ─────────────────────────────────────────────────────────────

const NOW = 10_000_000;

// The facts of a request that is asked; each test changes one.
function facts(over = {}) {
  return {
    settings: DEFAULTS,
    bodyBytes: 250_000,
    pinKey: 'sess~conv',
    sessionId: 'sess',
    pinned: 0,
    policy: /** @type {'recommend'|'force'} */ ('recommend'),
    verdict: null,
    windows: [
      { bucket: 'unified5h', utilization: 0.93, resetsAt: NOW + 72 * MINUTE },
      { bucket: 'unified7d', utilization: 0.40, resetsAt: NOW + 3 * 24 * HOUR },
    ],
    sibling: 'qb',
    asks: new CompactAsks({ now: () => NOW }),
    ...over,
  };
}

test('a large conversation near its 5-hour window, with a sibling, is asked', () => {
  const d = decideHandoffBeforeSwitch(facts());
  assert.equal(d.ask, true);
  assert.equal(d.reason, 'near-limit');
  assert.equal(d.window?.bucket, 'unified5h');
});

test('the window furthest past its own threshold is the one named', () => {
  // 5h 0.80 is 0.05 past 0.75; weekly 0.97 is 0.07 past 0.9.
  const d = decideHandoffBeforeSwitch(facts({ windows: [
    { bucket: 'unified5h', utilization: 0.80, resetsAt: null },
    { bucket: 'unified7d', utilization: 0.97, resetsAt: null },
  ] }));
  assert.equal(d.window?.bucket, 'unified7d');
  // 5h 0.91 is 0.16 past; it wins over the higher weekly reading.
  assert.equal(pastHandoffThreshold([
    { bucket: 'unified5h', utilization: 0.91, resetsAt: null },
    { bucket: 'unified7d', utilization: 0.97, resetsAt: null },
  ], DEFAULTS, NOW)?.bucket, 'unified5h');
});

test('5-hour and weekly windows each meet their own threshold', () => {
  const at = (/** @type {string} */ bucket, /** @type {number} */ utilization) => pastHandoffThreshold([{ bucket, utilization, resetsAt: null }], DEFAULTS, NOW);
  assert.equal(at('unified5h', 0.74), null);
  assert.equal(at('unified5h', 0.75)?.bucket, 'unified5h');
  for (const bucket of ['unified7d', 'unified7dFable', 'scopedWeekly']) {
    assert.equal(at(bucket, 0.85), null, `${bucket} 0.85 is not past the weekly threshold`);
    assert.equal(at(bucket, 0.9)?.bucket, bucket);
  }
  assert.equal(pastHandoffThreshold([{ bucket: 'unified5h', utilization: 0.95, resetsAt: NOW - 1 }], DEFAULTS, NOW), null, 'a turned-over window is skipped');
});

test('each condition that fails forwards the request, with its reason', () => {
  const cases = /** @type {[Record<string, any>, string][]} */ ([
    [{ settings: null }, 'off'],
    [{ sessionId: null }, 'no-session'],
    [{ pinKey: null }, 'no-session'],
    [{ bodyBytes: 199_999 }, 'small-body'],
    [{ pinned: null }, 'not-pinned'],
    [{ policy: 'force' }, 'force'],
    [{ verdict: { kind: 'spent' } }, 'cannot-serve'],
    [{ windows: [{ bucket: 'unified5h', utilization: 0.5, resetsAt: null }] }, 'not-near'],
    [{ windows: [{ bucket: 'unified7d', utilization: 0.85, resetsAt: null }] }, 'not-near'],
    [{ windows: [{ bucket: 'unified5h', utilization: null, resetsAt: null }] }, 'not-near'],
    [{ windows: [] }, 'not-near'],
    // A reading whose window already turned over says nothing about now.
    [{ windows: [{ bucket: 'unified5h', utilization: 0.95, resetsAt: NOW - 1 }] }, 'not-near'],
    [{ sibling: null }, 'no-sibling'],
  ]);
  for (const [over, reason] of cases) {
    const d = decideHandoffBeforeSwitch(facts(over));
    assert.deepEqual({ ask: d.ask, reason: d.reason }, { ask: false, reason }, JSON.stringify(over));
  }
});

test('a conversation is asked once per cooldown and a session once per gap', () => {
  const asks = new CompactAsks({ now: () => NOW });
  assert.equal(decideHandoffBeforeSwitch(facts({ asks })).ask, true);
  asks.record('sess~conv', 'sess', 250_000, DEFAULTS.cooldownMs);
  assert.equal(decideHandoffBeforeSwitch(facts({ asks })).reason, 'conversation-cooldown');
  assert.equal(decideHandoffBeforeSwitch(facts({ asks, pinKey: 'sess~other' })).reason, 'session-gap');
  assert.equal(decideHandoffBeforeSwitch(facts({ asks, now: NOW + DEFAULTS.cooldownMs })).ask, true);
});

// ── the answer ───────────────────────────────────────────────────────────────

test('relative times and window names read as a person writes them', () => {
  assert.equal(relativeTime(NOW + 30_000, NOW), 'less than a minute');
  assert.equal(relativeTime(NOW + 12 * MINUTE, NOW), '12m');
  assert.equal(relativeTime(NOW + 72 * MINUTE, NOW), '1h 12m');
  assert.equal(relativeTime(NOW + 2 * HOUR, NOW), '2h');
  assert.equal(relativeTime(NOW + 76 * HOUR, NOW), '3d 4h');
  assert.equal(windowLabel('unified5h'), '5-hour');
  assert.equal(windowLabel('unified7d'), 'weekly');
  assert.equal(windowLabel('unified7dFable'), 'weekly Fable');
});

test('the answer is an actionable 429 naming the account, window, reset, sibling and choices', () => {
  const answer = handoffAskAnswer({ account: 'qa', window: { bucket: 'unified5h', utilization: 0.93, resetsAt: NOW + 72 * MINUTE }, sibling: 'qb', cooldownMs: 1_800_000, now: NOW });
  assert.equal(answer.status, 429);
  assert.deepEqual(answer.headers, { 'Content-Type': 'application/json', 'x-should-retry': 'false' });
  const body = JSON.parse(answer.body);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
  const msg = body.error.message;
  assert.ok(msg.startsWith('The account "qa", pinned to this conversation, is at 93% of its 5-hour quota (resets in 1h 12m).'), msg);
  assert.match(msg, /"qb" appears available/);
  assert.match(msg, /run \/ipm:handoff/);
  assert.match(msg, /send any prompt to keep going here on "qa"/);
  assert.match(msg, /not be asked again for 30 minutes/);

  const noReset = JSON.parse(handoffAskAnswer({ account: 'qa', window: { bucket: 'unified7d', utilization: 0.951, resetsAt: null }, sibling: 'qb', cooldownMs: 60_000, now: NOW }).body).error.message;
  assert.ok(noReset.startsWith('The account "qa", pinned to this conversation, is at 95% of its weekly quota. '), noReset);
  assert.match(noReset, /for 1 minute\./);
});

test('the windows carry the 5-hour and governing weekly resets', () => {
  const am = new AccountManager([{ name: 'qa', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }], 0.98);
  const a = am.accounts[0];
  Object.assign(a.quota, { unified5h: 0.93, unified5hReset: NOW + HOUR, unified7d: 0.4, unified7dReset: NOW + 2 * HOUR });
  assert.deepEqual(handoffWindows(am, a, 'claude-opus-4-1'), [
    { bucket: 'unified5h', utilization: 0.93, resetsAt: NOW + HOUR },
    { bucket: 'unified7d', utilization: 0.4, resetsAt: NOW + 2 * HOUR },
  ]);
});

test('each weekly bucket is its own window: a shared weekly above the Fable bucket is shown with its own reset', () => {
  const am = new AccountManager([{ name: 'qa', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }], 0.98);
  const a = am.accounts[0];
  Object.assign(a.quota, {
    unified5h: 0.2, unified5hReset: NOW + HOUR,
    unified7d: 0.96, unified7dReset: NOW + 30 * HOUR,
    unified7dFable: 0.91, unified7dFableReset: NOW + 50 * HOUR,
  });
  const windows = handoffWindows(am, a, 'claude-fable-5');
  assert.deepEqual(windows, [
    { bucket: 'unified5h', utilization: 0.2, resetsAt: NOW + HOUR },
    { bucket: 'unified7d', utilization: 0.96, resetsAt: NOW + 30 * HOUR },
    { bucket: 'unified7dFable', utilization: 0.91, resetsAt: NOW + 50 * HOUR },
  ]);
  const d = decideHandoffBeforeSwitch(facts({ windows }));
  assert.deepEqual(d.window, { bucket: 'unified7d', utilization: 0.96, resetsAt: NOW + 30 * HOUR });
  const msg = JSON.parse(handoffAskAnswer({ account: 'qa', window: /** @type {any} */ (d.window), sibling: 'qb', cooldownMs: 1_800_000, now: NOW }).body).error.message;
  assert.match(msg, /is at 96% of its weekly quota \(resets in 1d 6h\)/);
});

test('free space is the tightest window against its own threshold; no reading, or a reset window, counts as unused', () => {
  const w = (bucket, utilization, resetsAt = NOW + HOUR) => ({ bucket, utilization, resetsAt });
  assert.equal(handoffHeadroom([w('unified5h', null), w('unified7d', null)], DEFAULTS, NOW), 0.75);
  assert.equal(handoffHeadroom([w('unified5h', 0.5), w('unified7d', 0.1)], DEFAULTS, NOW), 0.25);
  assert.equal(handoffHeadroom([w('unified5h', 0.1), w('unified7d', 0.6)], DEFAULTS, NOW), 0.3);
  assert.equal(handoffHeadroom([w('unified5h', 0.1), w('unified7d', 0.2), w('unified7dFable', 0.95)], DEFAULTS, NOW), -0.05);
  assert.equal(handoffHeadroom([w('unified5h', 0.99, NOW - 1), w('unified7d', 0.2)], DEFAULTS, NOW), 0.7, 'a reset window still counted');
  assert.equal(handoffHeadroom([w('unified5h', 0.4), w('unified7d', 0.55)], DEFAULTS, NOW), handoffHeadroom([w('unified5h', 0.1), w('unified7d', 0.55)], DEFAULTS, NOW), 'equal room must compare equal');
});

test('a seat ranks by free space, equal room keeps config order, and the setting off keeps config order', () => {
  const am = new AccountManager(['qa', 'qb', 'qc', 'qd'].map(name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR })), 0.98);
  const reset = Date.now() + 2 * HOUR;
  Object.assign(am.accounts[0].quota, { unified7d: 0.6, unified7dReset: reset });
  Object.assign(am.accounts[1].quota, { unified5h: 0.7, unified5hReset: reset });
  Object.assign(am.accounts[2].quota, { unified7d: 0.2, unified7dReset: reset });
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], 'claude-opus-4-1', DEFAULTS), [3, 2, 0, 1], 'qd (no reading: 0.75), qc (0.70), qa (0.30), qb (0.05)');
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], 'claude-opus-4-1', null), [0, 1, 2, 3]);
  Object.assign(am.accounts[0].quota, { unified7d: 0.2 });
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2], 'claude-opus-4-1', DEFAULTS), [0, 2, 1], 'qa and qc tie: config order');
  assert.deepEqual(rankByHeadroom(am, [2, 1, 0], 'claude-opus-4-1', DEFAULTS), [2, 0, 1], 'ties keep the order given');
});

test('a seat priority queue goes first among the accounts with room, then among those past, the rest by free space', () => {
  const am = new AccountManager(['qa', 'qb', 'qc', 'qd'].map(name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR })), 0.98);
  const reset = Date.now() + 2 * HOUR;
  Object.assign(am.accounts[0].quota, { unified7d: 0.6, unified7dReset: reset });
  Object.assign(am.accounts[1].quota, { unified7d: 0.95, unified7dReset: reset });
  Object.assign(am.accounts[2].quota, { unified7d: 0.2, unified7dReset: reset });
  Object.assign(am.accounts[3].quota, { unified5h: 0.8, unified5hReset: reset });
  const model = 'claude-opus-4-1';
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], model, DEFAULTS), [2, 0, 1, 3], 'no queue: free space, qb and qd tie');
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], model, DEFAULTS, [0]), [0, 2, 1, 3]);
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], model, DEFAULTS, [3, 0]), [0, 2, 3, 1], 'qd is past: it leads the past part, not the whole seat');
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], model, DEFAULTS, [7, 3]), [2, 0, 3, 1], 'an index off the seat is skipped');
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], model, null, [2, 0]), [2, 0, 1, 3], 'setting off: listed, then config order');
  assert.deepEqual(rankByHeadroom(am, [0, 1, 2, 3], model, null, []), [0, 1, 2, 3]);
  assert.equal(softDrainIndex(am, [0, 1, 2, 3], model, null, DEFAULTS, [3, 0]), 0);
  assert.deepEqual(preferSeatOrder([0, 1, 2], [2]), [2, 0, 1]);
});

test('the soft drain skips an account that cannot serve, and takes the most room even when every account is past', () => {
  const am = new AccountManager(['qa', 'qb', 'qc'].map(name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR })), 0.98);
  const reset = Date.now() + 2 * HOUR;
  Object.assign(am.accounts[0].quota, { unified5h: 0.9, unified5hReset: reset });
  Object.assign(am.accounts[1].quota, { unified7d: 0.99, unified7dReset: reset });
  Object.assign(am.accounts[2].quota, { unified5h: 0.8, unified5hReset: reset });
  assert.equal(softDrainIndex(am, [0, 1, 2], 'claude-opus-4-1', null, DEFAULTS), 2);
  recordSeatRejection(am.accounts[2], { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(reset / 1000)) }, 'claude-opus-4-1');
  assert.equal(softDrainIndex(am, [0, 1, 2], 'claude-opus-4-1', null, DEFAULTS), 1, 'qb (-0.09) over qa (-0.15) once qc cannot serve');
});

test('only a typed user prompt is a handoff moment, never a tool turn', () => {
  const body = (/** @type {any} */ last) => JSON.stringify({ messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'ok' }, last] });
  assert.equal(lastMessageIsTypedPrompt(body({ role: 'user', content: 'go on' })), true, 'string content is typed');
  assert.equal(lastMessageIsTypedPrompt(Buffer.from(body({ role: 'user', content: [{ type: 'text', text: 'go on' }] }))), true);
  assert.equal(lastMessageIsTypedPrompt(body({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] })), false);
  assert.equal(lastMessageIsTypedPrompt(body({ role: 'user', content: [{ type: 'text', text: 'and' }, { type: 'tool_result', tool_use_id: 't1', content: 'x' }] })), false);
  assert.equal(lastMessageIsTypedPrompt(body({ role: 'assistant', content: 'prefill' })), false);
  assert.equal(lastMessageIsTypedPrompt('{"messages":[]}'), false);
  assert.equal(lastMessageIsTypedPrompt('{not json'), false);
});

// ── the request path ─────────────────────────────────────────────────────────

const listen = (/** @type {http.Server} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(/** @type {any} */ (s.address()).port)));
const sec = (/** @type {number} */ ms) => String(Math.floor(ms / 1000));
const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key' };
const oauth = (/** @type {string} */ name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const ROUTES = [
  { name: 's1+s2+s3', clients: ['amy'], accounts: ['qa', 'qb', 'qc'] },
  { name: 'seat-r', clients: ['ben'], accounts: ['qr'] },
];
const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
const LARGE = 210_000;

/**
 * A gateway with a three-account seat (amy) and a one-account seat (ben) in
 * front of a stub upstream. `five[name]` and `week[name]` are the 5-hour and
 * weekly utilizations the stub reports for that account on every answer, so a
 * reading arrives the way a real one does.
 * @param {{ five?: Record<string, number>, week?: Record<string, number>, config?: Record<string, any>, policies?: any[] }} opts
 * @param {(h: { send: (r?: Record<string, any>) => Promise<any>, seen: string[], am: any, config: Record<string, any>, logs: string[], ends: any[] }) => Promise<void>} fn
 */
async function withGateway({ five = { qa: 0.93 }, week = {}, config: extra = {}, policies } = {}, fn) {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await new Promise(r => req.on('end', r));
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    if (five[who] != null) {
      headers['anthropic-ratelimit-unified-5h-utilization'] = String(five[who]);
      headers['anthropic-ratelimit-unified-5h-reset'] = sec(Date.now() + 2 * HOUR);
    }
    if (week[who] != null) {
      headers['anthropic-ratelimit-unified-7d-utilization'] = String(week[who]);
      headers['anthropic-ratelimit-unified-7d-reset'] = sec(Date.now() + 48 * HOUR);
    }
    res.writeHead(200, headers);
    res.end(okBody);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb'), oauth('qc'), oauth('qr')], 0.98, {
    clientRoutes: ROUTES,
    continuationPolicies: policies,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
    ...extra,
  };
  /** @type {any[]} */
  const ends = [];
  const proxy = createProxyServer(am, config, { onRequestEnd: (/** @type {number} */ _id, /** @type {any} */ info) => ends.push(info) });
  const port = await listen(proxy);
  /** @type {string[]} */
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  // One turn of one conversation, named by its opening; `pad` sizes the body.
  const send = async ({ key = KEYS.amy, session = 's-1', opening = 'first task', pad = LARGE, policy, order, worker, path = '/v1/messages', last = { role: 'user', content: 'go on' } } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-claude-code-session-id': session,
        ...(policy === undefined ? {} : { 'x-teamclaude-seat-policy': policy }),
        ...(order === undefined ? {} : { 'x-teamclaude-seat-order': order }),
        ...(worker === undefined ? {} : { 'x-teamclaude-worker-id': worker }),
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        messages: [
          { role: 'user', content: opening },
          { role: 'assistant', content: 'x'.repeat(pad) },
          last,
        ],
      }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, raw, json };
  };
  try {
    await fn({ send, seen, am, config, logs, ends });
  } finally {
    console.log = origLog;
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('near, large, recommend: one 429 handoff ask, nothing upstream; the next prompt reaches the warm account', async () => {
  await withGateway({}, async ({ send, seen, am, logs }) => {
    assert.equal((await send()).status, 200, 'the first turn pins the conversation and reads qa at 93%');
    assert.deepEqual(seen, ['qa']);

    const asked = await send();
    assert.equal(asked.status, 429);
    assert.equal(asked.headers.get('x-should-retry'), 'false');
    assert.equal(asked.headers.get('anthropic-ratelimit-unified-status'), null, 'no unified headers: Claude Code must show the text');
    assert.equal(asked.json?.error?.type, 'rate_limit_error');
    const msg = asked.json?.error?.message ?? '';
    assert.match(msg, /^The account "qa", pinned to this conversation, is at 93% of its 5-hour quota \(resets in (1h 5\dm|2h)\)\./);
    assert.match(msg, /"qb" appears available/);
    assert.match(msg, /\/ipm:handoff/);
    assert.deepEqual(seen, ['qa'], 'the ask was sent upstream');
    assert.equal(am.handoffAsks.asked, 1);
    assert.ok(logs.some(l => l.includes('to hand off before "qa" runs out') && l.includes('(handoffBeforeSwitch)')), logs.join('\n'));

    const next = await send();
    assert.equal(next.status, 200, 'the follow-up prompt is forwarded');
    assert.deepEqual(seen, ['qa', 'qa'], 'the follow-up went to qa, not qb');
    assert.equal(next.headers.get('x-teamclaude-seat-failover'), null);
    assert.equal((await send()).status, 200, 'still within the cooldown');
    assert.deepEqual(seen, ['qa', 'qa', 'qa']);
  });
});

test('a worker (x-teamclaude-worker-id) is never asked: nobody reads its 429', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    const worker = `w1_${'ab'.repeat(16)}`;
    assert.equal((await send({ worker })).status, 200);
    assert.equal((await send({ worker })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal(am.handoffAsks.asked, 0);
  });
});

test('below the utilization: forwarded', async () => {
  await withGateway({ five: { qa: 0.5 } }, async ({ send, seen }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('a small body: forwarded', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ pad: 1000 })).status, 200);
    assert.equal((await send({ pad: 2000 })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('force, by header or by owner root: forwarded', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ policy: '*=force' })).status, 200);
    assert.equal((await send({ policy: '*=force' })).status, 200, 'header force');
    assert.deepEqual(seen, ['qa', 'qa']);
  });
  const policies = [{ client: 'amy', keyHash: keyHashOf(KEYS.amy), mode: 'force', revision: 'r_one' }];
  await withGateway({ policies }, async ({ send, seen }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200, 'root force');
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('no sibling can serve: forwarded', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    assert.equal((await send()).status, 200);
    for (const i of [1, 2]) {
      recordSeatRejection(am.accounts[i], {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
      }, 'claude-opus-4-1');
    }
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('a single-account seat: forwarded', async () => {
  await withGateway({ five: { qr: 0.95 } }, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.ben })).status, 200);
    assert.equal((await send({ key: KEYS.ben })).status, 200);
    assert.deepEqual(seen, ['qr', 'qr']);
  });
});

test('disabled, including by a reload of the live config: forwarded', async () => {
  await withGateway({ config: { handoffBeforeSwitch: false } }, async ({ send, seen }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
  await withGateway({}, async ({ send, seen, config }) => {
    assert.equal((await send()).status, 200);
    // What POST /teamclaude/reload does: the key is reassigned on the shared object.
    config.handoffBeforeSwitch = false;
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
    config.handoffBeforeSwitch = { fiveHourUtilization: 0.92 };
    assert.equal((await send()).status, 429, 'turned back on and tuned by the next reload');
  });
});

test('a tuned threshold and body size apply', async () => {
  await withGateway({ five: { qa: 0.7 }, config: { handoffBeforeSwitch: { fiveHourUtilization: 0.65, minBodyBytes: 5000 } } }, async ({ send, seen }) => {
    assert.equal((await send({ pad: 6000 })).status, 200);
    assert.equal((await send({ pad: 6000 })).status, 429);
    assert.deepEqual(seen, ['qa']);
  });
});

test('a tool_result turn is forwarded; the next typed prompt is asked', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    assert.equal((await send()).status, 200);
    const tool = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] };
    assert.equal((await send({ last: tool })).status, 200, 'mid-task: forwarded');
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal(am.handoffAsks.asked, 0);
    assert.equal((await send()).status, 429, 'the typed prompt is asked');
    assert.equal(am.handoffAsks.asked, 1);
  });
});

test('a spent pinned account gets the post-limit offer, not the ask', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    assert.equal((await send()).status, 200);
    recordSeatRejection(am.accounts[0], {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
    }, 'claude-opus-4-1');
    const offer = await send();
    assert.equal(offer.status, 429);
    assert.match(offer.json?.error?.message ?? '', /next prompt confirms/);
    assert.doesNotMatch(offer.json?.error?.message ?? '', /\/ipm:handoff/);
    assert.deepEqual(seen, ['qa']);
    assert.equal(am.handoffAsks.asked, 0);
  });
});

test('count_tokens is forwarded and does not use up the ask', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send({ path: '/v1/messages/count_tokens' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal(am.handoffAsks.asked, 0);
    assert.equal((await send()).status, 429, 'the next completion is still asked');
  });
});

test('the ask closes its activity entry once, as a 429 on the seat', async () => {
  await withGateway({}, async ({ send, ends }) => {
    assert.equal((await send()).status, 200);
    const before = ends.length;
    assert.equal((await send()).status, 429);
    const mine = ends.slice(before);
    assert.equal(mine.length, 1, JSON.stringify(mine));
    assert.equal(mine[0].status, 429);
    assert.equal(mine[0].account, '(handoff before switch: qa)');
    assert.equal(mine[0].seat, 's1+s2+s3');
  });
});

test('an explicit account pin is never asked', async () => {
  await withGateway({}, async ({ send, seen, am }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send({ path: '/tc-acct/qa/v1/messages' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal(am.handoffAsks.asked, 0);
  });
});

// ── two thresholds and the soft drain ────────────────────────────────────────

/** Put a reading on an account directly, as if upstream had reported it. @param {any} account @param {Record<string, number>} q */
const reading = (account, q) => Object.assign(account.quota, q);

test('a 5-hour reading of 0.80 is asked, and names the account a new conversation starts on', async () => {
  await withGateway({ five: { qa: 0.8 } }, async ({ send, seen }) => {
    assert.equal((await send()).status, 200);
    const asked = await send();
    assert.equal(asked.status, 429);
    const msg = asked.json?.error?.message ?? '';
    assert.match(msg, /is at 80% of its 5-hour quota/);
    assert.match(msg, /a new conversation will start on "qb"/);
    assert.deepEqual(seen, ['qa']);
  });
});

test('a weekly reading of 0.85 is past neither threshold: not asked, and a new conversation starts on the freer qb', async () => {
  await withGateway({ five: {}, week: { qa: 0.85 } }, async ({ send, seen, am }) => {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200, 'not asked');
    assert.equal((await send({ opening: 'another task', pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
    assert.equal(am.handoffAsks.asked, 0);
  });
});

test('soft drain: a new conversation starts on qb while the one pinned to qa stays there', async () => {
  await withGateway({ five: { qa: 0.8 } }, async ({ send, seen }) => {
    assert.equal((await send({ pad: 100 })).status, 200, 'pins the first conversation to qa, which reads 0.80');
    assert.equal((await send({ opening: 'a new task', pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qa', 'qb'], 'the new conversation was not drained to qb');
    assert.equal((await send({ pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qa', 'qb', 'qa'], 'the pinned conversation moved');
  });
});

test('soft drain applies to workers too', async () => {
  await withGateway({ five: { qa: 0.8 } }, async ({ send, seen }) => {
    const worker = `w1_${'cd'.repeat(16)}`;
    assert.equal((await send({ worker, pad: 100 })).status, 200);
    assert.equal((await send({ worker, opening: 'a new task', pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qa', 'qb']);
  });
});

test('soft drain, every account past a threshold: the one with the most room (qb)', async () => {
  await withGateway({ five: {} }, async ({ send, seen, am }) => {
    const reset = Date.now() + 2 * HOUR;
    reading(am.accounts[0], { unified5h: 0.9, unified5hReset: reset });
    reading(am.accounts[1], { unified7d: 0.95, unified7dReset: reset });
    reading(am.accounts[2], { unified5h: 0.85, unified5hReset: reset });
    assert.equal((await send({ opening: 'a new task', pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qb']);
  });
});

test('soft drain off: a new conversation starts on qa even when it is past', async () => {
  await withGateway({ five: { qa: 0.8 }, config: { handoffBeforeSwitch: false } }, async ({ send, seen }) => {
    assert.equal((await send({ pad: 100 })).status, 200);
    assert.equal((await send({ opening: 'a new task', pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('when the pinned account still has the most room, the ask names the freest sibling and no new-conversation account', async () => {
  await withGateway({ five: { qa: 0.8 } }, async ({ send, am }) => {
    assert.equal((await send()).status, 200);
    const reset = Date.now() + 2 * HOUR;
    reading(am.accounts[1], { unified5h: 0.95, unified5hReset: reset });
    reading(am.accounts[2], { unified7d: 0.99, unified7dReset: reset });
    const asked = await send();
    assert.equal(asked.status, 429);
    const msg = asked.json?.error?.message ?? '';
    assert.match(msg, /\("qc" appears available\)/, 'qc (-0.09) has more room than qb (-0.20)');
    assert.doesNotMatch(msg, /a new conversation will start on/);
  });
});

test('with a seat order, the ask names the listed sibling and the listed new-conversation account', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ order: 's1' })).status, 200, 'pins the conversation to qa, which reads 93%');
    const asked = await send({ order: 's3,s1' });
    assert.equal(asked.status, 429);
    const msg = asked.json?.error?.message ?? '';
    assert.match(msg, /"qc" appears available/, 'qc is listed; without the order the freest sibling in config order is qb');
    assert.match(msg, /a new conversation will start on "qc"/);
    assert.doesNotMatch(msg, /"qb"/);
    assert.deepEqual(seen, ['qa']);
  });
});

test('new conversations start on the account with the most free space, not the first below the thresholds', async () => {
  await withGateway({ five: {} }, async ({ send, seen, am }) => {
    const reset = Date.now() + 48 * HOUR;
    reading(am.accounts[0], { unified5h: 0.1, unified5hReset: reset, unified7d: 0.5, unified7dReset: reset });
    reading(am.accounts[1], { unified5h: 0.1, unified5hReset: reset, unified7d: 0.2, unified7dReset: reset });
    reading(am.accounts[2], { unified5h: 0.1, unified5hReset: reset, unified7d: 0.6, unified7dReset: reset });
    assert.equal((await send({ opening: 'a new task', pad: 100 })).status, 200);
    assert.deepEqual(seen, ['qb'], 'qb has 0.65 of room, qa 0.40, qc 0.30');
  });
});
