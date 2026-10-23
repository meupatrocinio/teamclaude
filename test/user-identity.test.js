import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { gatewayUserTag, findUserIdSpan, stampGatewayUser } from '../src/user-identity.js';

// End-user identity stamping (IPM fork): a request carrying a client key is
// stamped with a stable hashed per-user tag in metadata.user_id, so upstream
// attributes per person rather than per seat. Device id, session id and
// account_uuid pass through untouched; the stamp never breaks a request.

const TAG_ANA = gatewayUserTag('ana');
const TAG_BOB = gatewayUserTag('bob');

const bodyWith = (userId) => Buffer.from(JSON.stringify({
  model: 'claude-opus-5',
  messages: [{ role: 'user', content: 'device_id inside content is "not metadata"' }],
  metadata: userId === undefined ? undefined : { user_id: userId },
}));
const REALISTIC = JSON.stringify({ device_id: 'dev-abc', account_uuid: 'acc-uuid-1', session_id: 'sess-1' });

// ── the tag ─────────────────────────────────────────────────────────────────

test('the tag is a stable normalized hash, never the name', () => {
  assert.match(TAG_ANA, /^u_[0-9a-f]{16}$/);
  assert.equal(gatewayUserTag(' Ana '), TAG_ANA, 'trimmed/case-insensitive like client routes');
  assert.notEqual(TAG_ANA, TAG_BOB);
  assert.ok(!TAG_ANA.includes('ana'), 'no PII in the tag');
});

// ── span finding ─────────────────────────────────────────────────────────────

test('finds the user_id string span in a realistic body', () => {
  const text = bodyWith(REALISTIC).toString();
  const span = findUserIdSpan(text);
  assert.equal(span.kind, 'userId');
  assert.equal(JSON.parse(`"${text.slice(span.start, span.end)}"`), REALISTIC);
});

test('a user_id-shaped string inside content is never matched', () => {
  const tricky = JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: 'look: {"metadata":{"user_id":"{\\"fake\\":1}"}}' }],
  });
  assert.equal(findUserIdSpan(tricky)?.kind, 'toplevel');
});

test('metadata without user_id inserts; no metadata appends', () => {
  const withMeta = JSON.stringify({ model: 'm', metadata: { other: 1 }, messages: [] });
  assert.equal(findUserIdSpan(withMeta)?.kind, 'metadata');
  const bare = JSON.stringify({ model: 'm', messages: [] });
  assert.equal(findUserIdSpan(bare)?.kind, 'toplevel');
});

// ── the stamp ────────────────────────────────────────────────────────────────

test('stamps gateway_user into the existing user_id, preserving every other field', () => {
  const out = JSON.parse(stampGatewayUser(bodyWith(REALISTIC), 'ana').toString());
  assert.deepEqual(JSON.parse(out.metadata.user_id), {
    device_id: 'dev-abc', account_uuid: 'acc-uuid-1', session_id: 'sess-1', gateway_user: TAG_ANA,
  });
  assert.equal(out.messages[0].content, 'device_id inside content is "not metadata"');
});

test('stamps when user_id or metadata is missing; idempotent on a repeat', () => {
  const noUserId = Buffer.from(JSON.stringify({ model: 'm', metadata: { other: 1 }, messages: [] }));
  const stamped1 = JSON.parse(stampGatewayUser(noUserId, 'ana').toString());
  assert.equal(stamped1.metadata.other, 1);
  assert.deepEqual(JSON.parse(stamped1.metadata.user_id), { gateway_user: TAG_ANA });

  const bare = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
  const stamped2 = JSON.parse(stampGatewayUser(bare, 'ana').toString());
  assert.deepEqual(JSON.parse(stamped2.metadata.user_id), { gateway_user: TAG_ANA });

  const again = stampGatewayUser(Buffer.from(JSON.stringify(stamped2)), 'ana');
  assert.equal(JSON.parse(again.toString()).metadata.user_id, JSON.stringify({ gateway_user: TAG_ANA }));
  const other = stampGatewayUser(Buffer.from(JSON.stringify(stamped2)), 'bob');
  assert.deepEqual(JSON.parse(JSON.parse(other.toString()).metadata.user_id), { gateway_user: TAG_BOB });
});

test('structural doubt returns the body untouched', () => {
  for (const bad of [
    Buffer.from('not json at all'),
    Buffer.from(JSON.stringify({ metadata: { user_id: 123 } })),
    Buffer.from(JSON.stringify({ metadata: 'meta' })),
    Buffer.from('{"model":"m","metadata":{"user_id":"{bad inner'),
  ]) {
    assert.equal(stampGatewayUser(bad, 'ana'), bad);
  }
});

test('non-ASCII conversation content survives the splice byte-exact', () => {
  const body = Buffer.from(JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: 'olá — 你好 — 🎉 — "quoted"' }],
    metadata: { user_id: REALISTIC },
  }));
  const out = JSON.parse(stampGatewayUser(body, 'ana').toString());
  assert.equal(out.messages[0].content, 'olá — 你好 — 🎉 — "quoted"');
  assert.equal(JSON.parse(out.metadata.user_id).device_id, 'dev-abc');
});

// ── wired into the forward path ──────────────────────────────────────────────

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('through the proxy: a client-key request arrives stamped, the admin key unstamped, Codex untouched', async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    received.push({ path: req.url, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upPort = await listen(upstream);
  const acct = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
  const codexAcct = {
    name: 'codex:c1', type: 'oauth', provider: 'codex', accountId: 'acct-c1',
    accessToken: 't-c1', refreshToken: 'r', expiresAt: Date.now() + HOUR, upstream: `http://127.0.0.1:${upPort}`,
  };
  const am = new AccountManager([acct('sa'), codexAcct], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'admin', clientKeys: [{ name: 'ana', key: 'ana-key' }] },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  const post = (path, key, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  try {
    await post('/v1/messages', 'ana-key', { model: 'claude-opus-4-1', messages: [], metadata: { user_id: REALISTIC } });
    const stamped = JSON.parse(received[0].body);
    assert.equal(JSON.parse(stamped.metadata.user_id).gateway_user, TAG_ANA);
    assert.equal(JSON.parse(stamped.metadata.user_id).device_id, 'dev-abc');

    await post('/v1/messages', 'admin', { model: 'claude-opus-4-1', messages: [], metadata: { user_id: REALISTIC } });
    assert.equal(JSON.parse(received[1].body).metadata.user_id, REALISTIC, 'the admin key goes unstamped');

    await post('/backend-api/codex/responses', 'ana-key', { model: 'gpt-5.6-sol', input: [] });
    const codexBody = JSON.parse(received[2].body);
    assert.equal(codexBody.metadata, undefined, 'a Codex body gets no Anthropic metadata');
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});
