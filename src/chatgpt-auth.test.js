import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { createChatGPTAuth, verifyChatGPTIdentity } from './chatgpt-auth.js';

const now = 1800000000000;
const initialAccount = () => ({ id: 'saved', client_id: 'oaiapp_saved', subject: 'person', name: 'Owner', access_token: 'old-access', refresh_token: 'refresh-one', scopes: ['chatgpt.tokens.use.direct'], expiresAt: now - 1000 });
function fixture(t, { accounts = {}, activeId = null, fetchImpl, verifyIdentity } = {}) {
  let saved = { hostId: 'urn:uuid:test-host', accounts, activeId };
  const store = { read: () => structuredClone(saved), write: (s) => { saved = structuredClone(s); } };
  const auth = createChatGPTAuth({ store, clock: () => now, fetchImpl: fetchImpl || (async () => { throw new Error('Unexpected network call'); }), verifyIdentity: verifyIdentity || (async (_token, _client, nonce) => ({ sub: 'person', email: 'owner@example.test', nonce })) });
  t.after(() => auth.cancel());
  return { auth, saved: () => saved };
}
const tokenResponse = (patch = {}) => Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: 'identity-secret', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', ...patch });

test('OAuth uses dynamic registration, PKCE, nonce and a stable loopback callback', async (t) => {
  const f = fixture(t);
  const first = new URL((await f.auth.beginLogin()).url);
  assert.equal(first.origin, 'https://auth.openai.com');
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('ext_agent_host_id'), 'urn:uuid:test-host');
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(first.searchParams.get('nonce'));
  assert.ok(first.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  const callback = new URL(first.searchParams.get('redirect_uri'));
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(callback.pathname, '/auth/callback');
  callback.search = new URLSearchParams({ state: 'wrong', code: 'code', client_id: 'oaiapp_test' });
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(f.auth.status().pending, true);
  const second = new URL((await f.auth.beginLogin()).url);
  assert.notEqual(second.searchParams.get('state'), first.searchParams.get('state'));
  assert.equal(second.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
});

test('validated OAuth completion stores credentials without exposing them in status', async (t) => {
  let exchange;
  const f = fixture(t, { fetchImpl: async (_url, opts) => { exchange = new URLSearchParams(opts.body); return tokenResponse(); } });
  const start = new URL((await f.auth.beginLogin()).url);
  const callback = new URL(start.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: start.searchParams.get('state'), code: 'one-time', client_id: 'oaiapp_test' });
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(exchange.get('client_id'), 'oaiapp_test');
  assert.equal(exchange.get('redirect_uri'), start.searchParams.get('redirect_uri'));
  assert.ok(exchange.get('code_verifier'));
  assert.equal(await f.auth.getAccessToken(), 'access-secret');
  const status = f.auth.status();
  assert.equal(status.account.planEnabled, true);
  for (const secret of ['access-secret', 'refresh-secret', 'identity-secret']) assert.equal(JSON.stringify(status).includes(secret), false);
});

test('identity-only scope cannot authorize inference', async (t) => {
  const f = fixture(t, { fetchImpl: async () => tokenResponse({ scope: 'openid email' }) });
  const start = new URL((await f.auth.beginLogin()).url), callback = new URL(start.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: start.searchParams.get('state'), code: 'one-time', client_id: 'oaiapp_test' });
  await fetch(callback);
  assert.equal(f.auth.status().account.planEnabled, false);
  await assert.rejects(f.auth.getAccessToken(), /not authorized/);
});

test('returning account cannot replace credentials with a different identity', async (t) => {
  const f = fixture(t, { accounts: { saved: initialAccount() }, activeId: 'saved', fetchImpl: async () => tokenResponse(), verifyIdentity: async () => ({ sub: 'different-person' }) });
  const start = new URL((await f.auth.beginLogin()).url), callback = new URL(start.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: start.searchParams.get('state'), code: 'one-time', client_id: 'oaiapp_saved' });
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(f.saved().accounts.saved.access_token, 'old-access');
});

test('concurrent access serializes refresh and saves rotating credentials together', async (t) => {
  let calls = 0;
  const f = fixture(t, { accounts: { saved: initialAccount() }, activeId: 'saved', fetchImpl: async (_url, opts) => { calls++; assert.equal(new URLSearchParams(opts.body).get('client_id'), 'oaiapp_saved'); await new Promise((r) => setTimeout(r, 5)); return tokenResponse(); } });
  const tokens = await Promise.all(Array.from({ length: 10 }, () => f.auth.getAccessToken()));
  assert.equal(calls, 1);
  assert.ok(tokens.every((x) => x === 'access-secret'));
  assert.equal(f.saved().accounts.saved.refresh_token, 'refresh-secret');
  assert.equal(f.saved().accounts.saved.expiresAt, now + 3600000);
});

test('temporary refresh failure preserves credentials; revoked refresh requires sign-in', async (t) => {
  for (const [status, code] of [[503, 'subscription_sharing_usage_unavailable'], [400, 'invalid_grant']]) {
    const f = fixture(t, { accounts: { saved: initialAccount() }, activeId: 'saved', fetchImpl: async () => Response.json({ error: { code } }, { status }) });
    await assert.rejects(f.auth.getAccessToken());
    assert.equal(f.auth.status().account.needsSignIn, code === 'invalid_grant');
    assert.equal(f.saved().accounts.saved.refresh_token, code === 'invalid_grant' ? undefined : 'refresh-one');
  }
});

test('OIDC validation rejects wrong signatures, issuers, audiences, nonce and expiry', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey); key.kid = 'test';
  const keys = createLocalJWKSet({ keys: [key] });
  const mint = (patch = {}) => new SignJWT({ nonce: 'nonce', ...patch }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(patch.iss || 'https://auth.openai.com').setAudience(patch.aud || 'oaiapp_test').setSubject('person').setIssuedAt().setExpirationTime(patch.exp || '5m').sign(privateKey);
  const valid = await mint();
  assert.equal((await verifyChatGPTIdentity(valid, 'oaiapp_test', 'nonce', keys)).sub, 'person');
  for (const token of [await mint({ iss: 'https://other.test' }), await mint({ aud: 'other' }), await mint({ nonce: 'other' }), await mint({ exp: 1 })]) await assert.rejects(verifyChatGPTIdentity(token, 'oaiapp_test', 'nonce', keys));
  const parts = valid.split('.'); parts[2] = Buffer.from('invalid-signature').toString('base64url');
  await assert.rejects(verifyChatGPTIdentity(parts.join('.'), 'oaiapp_test', 'nonce', keys));
});
