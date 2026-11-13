import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { ClaudeReauthFlows } from '../src/claude-reauth.js';
import { exactReauthIdentity, renderedReauthIdentity } from '../src/identity.js';
import { createProxyServer } from '../src/server.js';

const IDENTITY = {
  accountUuid: '11111111-1111-4111-8111-111111111111',
  orgUuid: '22222222-2222-4222-8222-222222222222',
};
const ACCOUNT = {
  id: 'seat', name: 'seat@example.com', type: 'oauth', accessToken: 'old-secret', ...IDENTITY,
};
const CREDS = { accessToken: 'new-access-secret', refreshToken: 'new-refresh-secret', expiresAt: 2_000_000_000_000 };

function fakeStart() {
  const calls = [];
  const startFlow = async opts => {
    const state = 'state-secret';
    const flow = {
      url: `https://claude.ai/oauth/authorize?state=${state}`,
      submit(code) {
        calls.push(code);
        if (code === 'bad') throw new Error('state mismatch');
        return code === `code#${state}`;
      },
      tokens: Promise.resolve(CREDS),
    };
    calls.push({ loopback: opts.loopback, signal: opts.signal });
    return flow;
  };
  return { calls, startFlow };
}

test('UUID matching fails closed and never falls back to names or emails', () => {
  assert.deepEqual(renderedReauthIdentity(ACCOUNT), IDENTITY);
  assert.throws(() => renderedReauthIdentity({ ...ACCOUNT, accountUuid: null }), err => err.code === 'identity_unproven');
  assert.throws(() => renderedReauthIdentity({ ...ACCOUNT, provider: 'codex' }), err => err.code === 'not_anthropic_oauth');
  assert.equal(exactReauthIdentity(IDENTITY, { ...IDENTITY, email: 'different@example.com' }), true);
  assert.equal(exactReauthIdentity(IDENTITY, { ...IDENTITY, accountUuid: 'different' }), false);
  assert.equal(exactReauthIdentity(IDENTITY, { accountUuid: IDENTITY.accountUuid }), false);
  assert.equal(exactReauthIdentity(IDENTITY, { ...IDENTITY, error: 'timeout' }), false);
});

test('manual OAuth returns a complete bundle without writing an account or config', async () => {
  const { calls, startFlow } = fakeStart();
  const flows = new ClaudeReauthFlows({ startFlow, profile: async token => {
    assert.equal(token, CREDS.accessToken);
    return { ...IDENTITY, email: 'ignored@example.com' };
  } });
  const started = await flows.start(ACCOUNT);
  assert.equal(calls[0].loopback, false);
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const completed = await flows.complete(started.flowId, `code#${state}`);
  assert.deepEqual(completed, { credentials: CREDS, identity: IDENTITY });
  await assert.rejects(flows.complete(started.flowId, `code#${state}`), err => err.code === 'flow_not_found');
  assert.doesNotMatch(JSON.stringify(started), /new-access-secret|new-refresh-secret|old-secret/);
});

test('wrong or unknown identity discards credentials and consumes the flow', async () => {
  for (const profile of [
    { ...IDENTITY, accountUuid: 'wrong-account' },
    { ...IDENTITY, orgUuid: 'wrong-org' },
    { error: 'profile unavailable', status: null },
  ]) {
    const { startFlow } = fakeStart();
    const flows = new ClaudeReauthFlows({ startFlow, profile: async () => profile });
    const started = await flows.start(ACCOUNT);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await assert.rejects(flows.complete(started.flowId, `code#${state}`), err => err.code === 'identity_mismatch');
    await assert.rejects(flows.complete(started.flowId, `code#${state}`), err => err.code === 'flow_not_found');
  }
});

test('a malformed paste is an explicit pre-write retry, not an exchange or retry loop', async () => {
  const { calls, startFlow } = fakeStart();
  let profiles = 0;
  const flows = new ClaudeReauthFlows({ startFlow, profile: async () => { profiles++; return IDENTITY; } });
  const started = await flows.start(ACCOUNT);
  await assert.rejects(flows.complete(started.flowId, 'bad'), err => err.code === 'invalid_code');
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  await flows.complete(started.flowId, `code#${state}`);
  assert.equal(profiles, 1);
  assert.equal(calls.filter(call => typeof call === 'string').length, 2);
});

test('a hung token exchange is bounded and cannot be retried automatically', async () => {
  const base = fakeStart();
  const startFlow = async opts => ({
    ...(await base.startFlow(opts)),
    tokens: new Promise(() => {}),
  });
  const flows = new ClaudeReauthFlows({ startFlow, completionTimeoutMs: 5 });
  const started = await flows.start(ACCOUNT);
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  await assert.rejects(flows.complete(started.flowId, `code#${state}`), err => err.code === 'oauth_timeout');
  await assert.rejects(flows.complete(started.flowId, `code#${state}`), err => err.code === 'flow_not_found');
});

test('concurrent starts cannot exceed the global flow cap', async () => {
  const gates = [];
  const startFlow = async () => {
    await new Promise(resolve => gates.push(resolve));
    return {
      url: 'https://claude.ai/oauth/authorize?state=state',
      submit: () => true,
      tokens: Promise.resolve(CREDS),
    };
  };
  const flows = new ClaudeReauthFlows({ startFlow });
  const pending = Array.from({ length: 20 }, () => flows.start(ACCOUNT));
  while (gates.length < 20) await new Promise(resolve => setImmediate(resolve));
  gates.forEach(resolve => resolve());
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 8);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 12);
  assert.equal(flows.flows.size, 8);
  flows.expire(Infinity);
  assert.equal(flows.flows.size, 0);
});

async function withServer(fn) {
  const am = new AccountManager([ACCOUNT], 0.98);
  const calls = { start: 0, complete: 0, reload: 0, reset: 0 };
  const flows = new ClaudeReauthFlows({
    startFlow: fakeStart().startFlow,
    profile: async () => IDENTITY,
  });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'operator', clientKeys: [{ name: 'tenant', key: 'client' }] },
    upstream: 'http://127.0.0.1:9',
  }, {
    startClaudeReauth: async index => { calls.start++; return flows.start(am.accounts[index]); },
    completeClaudeReauth: async (id, code) => { calls.complete++; return flows.complete(id, code); },
    reload: async () => { calls.reload++; },
    redeemClaudeReset: async () => { calls.reset++; },
  });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const post = (path, body, key = 'operator') => fetch(`http://127.0.0.1:${port}/teamclaude/claude-reauth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  try { await fn({ calls, post }); } finally { proxy.close(); }
}

test('operator routes carry the URL once, then credentials only to the backend, with no reload/reset', async () => {
  await withServer(async ({ calls, post }) => {
    const startedRes = await post('start', { account: 'seat@example.com' });
    assert.equal(startedRes.status, 200);
    assert.equal(startedRes.headers.get('cache-control'), 'no-store');
    const started = await startedRes.json();
    assert.equal(started.identity.accountUuid, IDENTITY.accountUuid);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const completedRes = await post('complete', { flowId: started.flowId, code: `code#${state}` });
    assert.equal(completedRes.status, 200);
    const completed = await completedRes.json();
    assert.deepEqual(completed.credentials, CREDS);
    assert.deepEqual(calls, { start: 1, complete: 1, reload: 0, reset: 0 });
  });
});

test('client keys are refused before OAuth acquisition or credential return', async () => {
  await withServer(async ({ calls, post }) => {
    for (const [path, body] of [
      ['start', { account: 'seat@example.com' }],
      ['complete', { flowId: 'secret-flow', code: 'secret-code' }],
    ]) {
      const res = await post(path, body, 'client');
      assert.equal(res.status, 403);
      assert.doesNotMatch(JSON.stringify(await res.json()), /secret-flow|secret-code|new-access-secret/);
    }
    assert.deepEqual(calls, { start: 0, complete: 0, reload: 0, reset: 0 });
  });
});

test('unknown identity and malformed input never reach OAuth or echo a code', async () => {
  await withServer(async ({ calls, post }) => {
    const missing = await post('start', { account: 'missing@example.com' });
    assert.equal(missing.status, 404);
    const extra = await post('complete', { flowId: 'secret-flow', code: 'secret-code', account: 'seat@example.com' });
    assert.equal(extra.status, 400);
    assert.doesNotMatch(JSON.stringify(await extra.json()), /secret-flow|secret-code/);
    assert.deepEqual(calls, { start: 0, complete: 0, reload: 0, reset: 0 });
  });
});
