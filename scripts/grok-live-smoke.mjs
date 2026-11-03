#!/usr/bin/env node
// Opt-in, bounded xAI smoke. Run with XAI_API_KEY set; never prints the key.
// GROK_SMOKE_URL may point at xAI or the gateway. GROK_SMOKE_MODEL selects any native model.

const base = (process.env.GROK_SMOKE_URL || 'https://api.x.ai').replace(/\/$/, '');
const key = process.env.GROK_SMOKE_KEY || process.env.XAI_API_KEY;
const model = process.env.GROK_SMOKE_MODEL || 'grok-build-0.1';
const alias = process.env.GROK_SMOKE_CLAUDE_ALIAS || 'claude-opus-5-5';

if (!key) {
  console.error('Set XAI_API_KEY (or GROK_SMOKE_KEY) before running this smoke.');
  process.exit(2);
}

const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const call = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${base}${path}`, { ...options, headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
};
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });
const usage = (value) => value && typeof value === 'object' ? value : null;

const models = await call('/v1/models');
const modelList = JSON.parse(models.text);
console.log(`models: ${(modelList.data ?? []).slice(0, 12).map((m) => m.id).join(', ') || '(none returned)'}`);
if (!(modelList.data ?? []).some((m) => m.id === model) && !modelList.data?.some((m) => (m.aliases ?? []).includes(model))) {
  throw new Error(`Requested native model ${model} is not in /v1/models`);
}

const text = await post('/v1/messages', {
  model,
  max_tokens: 32,
  store: false,
  metadata: { user_id: 'grok-live-smoke' },
  messages: [{ role: 'user', content: 'Reply with exactly: grok-smoke-ok' }],
});
const message = JSON.parse(text.text);
const content = message.content ?? [];
if (!content.some((block) => block.type === 'text' && String(block.text).includes('grok-smoke-ok'))) {
  throw new Error(`Text smoke returned unexpected content: ${text.text.slice(0, 500)}`);
}
console.log(`text: ok; usage=${JSON.stringify(usage(message.usage))}`);

const toolCall = await post('/v1/messages', {
  model,
  max_tokens: 128,
  store: false,
  tool_choice: 'required',
  tools: [{ name: 'read_file', description: 'Read a small file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  messages: [{ role: 'user', content: 'Call read_file with path README.md' }],
});
const callJson = JSON.parse(toolCall.text);
const toolUse = (callJson.content ?? []).find((block) => block.type === 'tool_use');
if (!toolUse?.id || !toolUse.name) throw new Error(`Tool call was not returned: ${toolCall.text.slice(0, 500)}`);
const toolResult = await post('/v1/messages', {
  model,
  max_tokens: 64,
  store: false,
  messages: [
    { role: 'assistant', content: [toolUse] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'file contents' }] },
  ],
});
const resultJson = JSON.parse(toolResult.text);
if (!(resultJson.content ?? []).some((block) => block.type === 'text')) throw new Error('Tool result continuation returned no text');
console.log('tool call/result: ok');

const stream = await post('/v1/messages', {
  model,
  max_tokens: 32,
  store: false,
  stream: true,
  messages: [{ role: 'user', content: 'Reply with exactly: grok-smoke-ok' }],
});
for (const required of ['message_start', 'content_block_start', 'content_block_delta', 'message_stop']) {
  if (!stream.text.includes(required)) throw new Error(`Streaming response is missing ${required}`);
}
if (stream.text.includes('"type":"error"') || stream.text.includes('authentication_error') || stream.text.includes('rate_limit_error') || stream.text.includes('api_error')) {
  throw new Error(`Streaming response returned an error: ${stream.text.slice(0, 500)}`);
}
console.log(`streaming: ok; native model=${model}; alias default=${alias}`);
console.log('GROK_SMOKE_PASS');
