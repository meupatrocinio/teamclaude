import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

// Live reload (POST /teamclaude/reload) must hot-apply `handoffBeforeSwitch`
// (IPM fork). The request path resolves the setting per request off the shared
// config object and status resolves it off that same object, so the status
// echo is the witness that a reload reached the object the gate reads. That
// the gate follows the object from one request to the next is shown
// in-process, in handoff-before-switch.test.js.

/** @param {number} port */
async function handoffStatus(port) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
  assert.equal(res.status, 200);
  return (await res.json()).handoffBeforeSwitch;
}

/**
 * @param {number} port
 * @param {string} configPath
 * @param {(config: Record<string, any>) => void} mutate
 */
async function reloadWith(port, configPath, mutate) {
  const edited = JSON.parse(await readFile(configPath, 'utf8'));
  mutate(edited);
  await writeFile(configPath, JSON.stringify(edited));
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
  const text = await res.text();
  assert.equal(res.status, 200, text);
}

test('reload hot-applies a handoffBeforeSwitch edit, in both directions', async () => {
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const { port, configPath } = server;
  const defaults = { enabled: true, utilization: 0.9, minBodyBytes: 200000, cooldownSeconds: 1800, asked: 0 };
  try {
    assert.deepEqual(await handoffStatus(port), defaults, 'on unless set');

    await reloadWith(port, configPath, c => { c.handoffBeforeSwitch = false; });
    assert.deepEqual(await handoffStatus(port), { enabled: false, asked: 0 });

    await reloadWith(port, configPath, c => { c.handoffBeforeSwitch = { utilization: 0.8, minBodyBytes: 'big', cooldownSeconds: 60 }; });
    assert.deepEqual(await handoffStatus(port), { ...defaults, utilization: 0.8, cooldownSeconds: 60 }, 'a bad field takes its default');

    await reloadWith(port, configPath, c => { delete c.handoffBeforeSwitch; });
    assert.deepEqual(await handoffStatus(port), defaults, 'removing the key turns it back on');
  } finally {
    await server.stop();
  }
});
