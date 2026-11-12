import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';

// Production composition: both routes use the same flow object installed by
// src/index.js. A wrong state is refused before any token endpoint is needed.
test('real startup registers shared reauthentication hooks without config writes or reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-reauth-startup-'));
  const server = await spawnServer({
    dir,
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: 'http://127.0.0.1:9',
      accounts: [{
        id: 'live', name: 'live@example.com', type: 'oauth', accessToken: 'old-secret',
        accountUuid: 'account-live', orgUuid: 'org-live', expiresAt: Date.now() + 3_600_000,
      }],
    }),
  });
  try {
    const before = await readFile(server.configPath, 'utf8');
    const startedRes = await fetch(`http://127.0.0.1:${server.port}/teamclaude/claude-reauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ account: 'live@example.com' }),
    });
    assert.equal(startedRes.status, 200);
    const started = await startedRes.json();
    assert.equal(started.identity.accountUuid, 'account-live');
    assert.equal(started.identity.orgUuid, 'org-live');
    assert.doesNotMatch(JSON.stringify(started), /old-secret/);

    const completedRes = await fetch(`http://127.0.0.1:${server.port}/teamclaude/claude-reauth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ flowId: started.flowId, code: 'code#wrong-state' }),
    });
    assert.equal(completedRes.status, 400);
    assert.deepEqual(await completedRes.json(), { ok: false, reason: 'invalid_code' });
    assert.equal(await readFile(server.configPath, 'utf8'), before);
  } finally {
    await server.stop();
  }
});
