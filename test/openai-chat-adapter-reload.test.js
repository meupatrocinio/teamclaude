import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

const FIELDS = { adapter: 'openai-chat', modelPrefix: 'models/', serverHeader: 'agy-one' };
const entry = (extra = {}) => ({ id: 'x', name: 'x@example.com', type: 'apikey', apiKey: 'k', ...extra });

async function roundTrip(startup, disk) {
  const memConfig = { accounts: [startup] };
  const am = new AccountManager(memConfig.accounts.map(account => ({ ...account })), 0.98);
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const written = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);
  await syncAccountsFromDisk({ accounts: written }, memConfig, am);
  return { written: written[0], running: am.accounts[0], memConfig };
}

test('startup carries adapter fields and ordinary accounts default to null', () => {
  const am = new AccountManager([entry(FIELDS), entry({ id: 'y', name: 'y' })], 0.98);
  assert.equal(am.accounts[0].adapter, 'openai-chat');
  assert.equal(am.accounts[0].modelPrefix, 'models/');
  assert.equal(am.accounts[0].serverHeader, 'agy-one');
  for (const field of Object.keys(FIELDS)) assert.equal(am.accounts[1][field], null);
});

test('runtime additions carry the same adapter fields', async () => {
  const am = new AccountManager([], 0.98);
  const memConfig = { accounts: [] };
  const added = await syncAccountsFromDisk({ accounts: [entry(FIELDS)] }, memConfig, am);
  assert.equal(added.added, 1);
  assert.equal(am.accounts[0].adapter, 'openai-chat');
  assert.equal(am.accounts[0].modelPrefix, 'models/');
  assert.equal(am.accounts[0].serverHeader, 'agy-one');
});

test('reload edits survive the next save and a second reload', async () => {
  const startup = entry({ adapter: 'openai-chat', modelPrefix: 'old/', serverHeader: 'old' });
  const disk = entry({ adapter: 'openai-chat', modelPrefix: 'models/', serverHeader: 'agy-two' });
  const { written, running, memConfig } = await roundTrip(startup, disk);
  assert.equal(written.adapter, 'openai-chat');
  assert.equal(written.modelPrefix, 'models/');
  assert.equal(written.serverHeader, 'agy-two');
  assert.equal(running.adapter, 'openai-chat');
  assert.equal(running.modelPrefix, 'models/');
  assert.equal(running.serverHeader, 'agy-two');
  assert.equal(memConfig.accounts[0].serverHeader, 'agy-two');
});

test('removing adapter fields on disk deletes their mirrors instead of resurrecting them', async () => {
  const { written, running, memConfig } = await roundTrip(entry(FIELDS), entry());
  for (const field of Object.keys(FIELDS)) {
    assert.equal(field in written, false, `${field} was resurrected by the save`);
    assert.equal(field in memConfig.accounts[0], false);
    assert.equal(running[field], null);
  }
});
