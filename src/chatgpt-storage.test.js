import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCredentialStore } from './chatgpt-storage.js';
import { createChatGPTAuth } from './chatgpt-auth.js';

function temp(t) {
  const root = path.resolve(tmpdir());
  const folder = mkdtempSync(path.join(root, 'champ-auth-test-'));
  t.after(() => { if (path.dirname(path.resolve(folder)) !== root) throw new Error('Unexpected test cleanup path'); rmSync(folder, { recursive: true, force: true }); });
  return folder;
}
test('credential store round-trips protected data and preserves host identity', (t) => {
  const directory = temp(t);
  const store = createCredentialStore({ directory });
  const initial = store.read(); initial.accounts.example = { access_token: 'fake-test-token' }; store.write(initial);
  assert.deepEqual(store.read(), initial);
  if (process.platform === 'win32') assert.equal(readFileSync(path.join(directory, 'credentials.json'), 'utf8').includes('fake-test-token'), false);
});

test('separate auth instances coordinate rotating refreshes through the storage lock', async (t) => {
  const directory = temp(t);
  const store = createCredentialStore({ directory, protect: (v) => v, unprotect: (v) => v });
  const now = Date.now();
  store.write({ hostId: 'test', activeId: 'owner', accounts: { owner: { id: 'owner', client_id: 'oaiapp_test', access_token: 'old', refresh_token: 'rotate-once', expiresAt: now - 1, scopes: ['chatgpt.tokens.use.direct'] } } });
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 15)); return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }); };
  const first = createChatGPTAuth({ store, fetchImpl }), second = createChatGPTAuth({ store, fetchImpl });
  assert.deepEqual(await Promise.all([first.getAccessToken(), second.getAccessToken()]), ['new', 'new']);
  assert.equal(calls, 1);
  assert.equal(store.read().accounts.owner.refresh_token, 'rotated');
});
