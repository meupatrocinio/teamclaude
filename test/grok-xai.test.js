import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const KEY = 'xai-test-key';
const okBody = JSON.stringify({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}\n\n'
  + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
  + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function withGateway(handler, fn) {
  const attempts = [];
  const upstream = http.createServer(async (req, res, _body) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    attempts.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: rawBody });
    await handler(req, res, rawBody);
  });
  const upstreamPort = await listen(upstream);
  const grok = {
    name: 'grok',
    type: 'oauth',
    provider: 'anthropic',
    adapter: 'grok',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    accessToken: KEY,
    modelMap: { 'claude-opus-5-5': 'grok-build-0.1' },
  };
  const am = new AccountManager([grok], 0.98, {
    clientRoutes: [{ name: 'grok', clients: ['amy'], accounts: ['grok'] }],
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'amy', key: 'amy-key' }], requireClientRoute: true },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const port = await listen(proxy);
  const send = async (path, body = null) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': 'amy-key', 'x-claude-code-session-id': 'grok-test' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await fn({ send, attempts });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

const messages = (model, extra = {}) => ({ model, messages: [{ role: 'user', content: 'hello' }], ...extra });

test('native Grok model and Claude alias use xAI bearer auth and exact model mapping', async () => {
  await withGateway((req, res, _body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(okBody);
  }, async ({ send, attempts }) => {
    const native = await send('/v1/messages', messages('grok-4.7'));
    assert.equal(native.status, 200);
    const alias = await send('/v1/messages', messages('claude-opus-5-5'));
    assert.equal(alias.status, 200);
    assert.deepEqual(attempts.map(a => a.url), ['/v1/messages', '/v1/messages']);
    assert.deepEqual(attempts.map(a => a.authorization), [`Bearer ${KEY}`, `Bearer ${KEY}`]);
    assert.deepEqual(attempts.map(a => JSON.parse(a.body).model), ['grok-4.7', 'grok-build-0.1']);
  });
});

test('model discovery and tool results follow the same Anthropic path', async () => {
  await withGateway((req, res, body) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-build-0.1', aliases: ['grok-code-fast-1'] }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (body.includes('tool_result')) {
      res.end(JSON.stringify({ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'file contents' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 3 } }));
      return;
    }
    res.end(JSON.stringify({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } }));
  }, async ({ send, attempts }) => {
    const models = await send('/v1/models');
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).data[0].id, 'grok-build-0.1');
    const tool = await send('/v1/messages', messages('grok-build-0.1', { tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }));
    assert.equal(tool.status, 200);
    assert.equal((await tool.json()).content[0].type, 'tool_use');
    const result = await send('/v1/messages', messages('grok-build-0.1', {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
      ],
    }));
    assert.equal(result.status, 200);
    assert.equal(attempts.at(-1).body.includes('tool_result'), true);
  });
});

test('Anthropic SSE bytes and upstream errors pass through unchanged', async () => {
  await withGateway((req, res, body) => {
    if (body.includes('fail')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  }, async ({ send }) => {
    const stream = await send('/v1/messages', messages('grok-build-0.1', { stream: true }));
    assert.equal(stream.status, 200);
    assert.equal(await stream.text(), sse);
    const failed = await send('/v1/messages', messages('grok-build-0.1', { fail: true }));
    assert.equal(failed.status, 400);
    assert.equal((await failed.json()).error.message, 'bad key');
  });
});
