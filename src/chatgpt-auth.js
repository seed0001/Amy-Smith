import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createCredentialStore } from './chatgpt-storage.js';

const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function verifyChatGPTIdentity(token, clientId, nonce, keys = jwks) {
  const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
  if (!same(payload.nonce, nonce) || !payload.sub) throw new Error('OpenAI sign-in identity validation failed');
  return payload;
}

export class ChatGPTError extends Error {
  constructor(message, { code = '', status = 500, requestId = '' } = {}) { super(message); this.code = code; this.status = status; this.requestId = requestId; }
}

// Keep remote diagnostics structured without exposing request bodies, credentials or tokens.
export async function openAIError(res) {
  const data = await res.json().catch(() => ({}));
  const code = typeof data.error === 'string' ? data.error : data.error?.code || '';
  const explanations = {
    subscription_sharing_user_not_eligible: 'This ChatGPT account or workspace is not eligible for plan usage in Amy.',
    subscription_sharing_usage_limit_exceeded: 'Amy has reached a ChatGPT plan or app usage limit. Check ChatGPT Settings → Usage.',
    subscription_sharing_route_not_supported: 'OpenAI does not support this subscription request route.',
    subscription_sharing_unsupported_capability: 'OpenAI rejected an unsupported capability for this ChatGPT subscription request.',
    invalid_grant: 'ChatGPT sign-in expired or was revoked. Sign in again.',
    invalid_refresh_token: 'ChatGPT sign-in expired or was revoked. Sign in again.',
  };
  return new ChatGPTError(explanations[code] || (res.status === 401 ? 'ChatGPT authorization was not accepted. Reconnect in dashboard Settings → Brain.' : `ChatGPT request failed (HTTP ${res.status}${code ? `, ${code}` : ''}).`), { code, status: res.status, requestId: res.headers.get('x-request-id') || '' });
}

export function createChatGPTAuth({ store = createCredentialStore(), fetchImpl = fetch, verifyIdentity = verifyChatGPTIdentity, clock = Date.now } = {}) {
  let pending = null, lastError = '';
  const refreshes = new Map();
  let catalogCache = null;
  // Load lazily so simply importing a module never creates credentials or starts sign-in.
  const read = () => store.read();
  const account = () => { const s = read(); return s.accounts[s.activeId] ?? null; };
  const publicAccount = (a) => ({ id: a.id, email: a.email || '', name: a.name || '', planEnabled: a.scopes?.includes('chatgpt.tokens.use.direct') ?? false, needsSignIn: Boolean(a.needsSignIn) });
  function status() {
    const s = read(), a = s.accounts[s.activeId];
    return { connected: Boolean(a), account: a ? publicAccount(a) : null, accounts: Object.values(s.accounts).map(publicAccount), pending: Boolean(pending), error: lastError, usageUrl: 'https://chatgpt.com/#settings/Usage' };
  }
  async function tokens(body) {
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!res.ok) throw await openAIError(res);
    return res.json();
  }
  function mergeTokens(previous, t) {
    if (typeof t.access_token !== 'string' || !t.access_token || !Number.isFinite(t.expires_in) || t.expires_in <= 0 || (t.token_type && t.token_type.toLowerCase() !== 'bearer')) throw new Error('OpenAI returned an incomplete token response');
    return { ...previous, access_token: t.access_token, refresh_token: t.refresh_token || previous.refresh_token, id_token: t.id_token || previous.id_token, scopes: typeof t.scope === 'string' ? t.scope.split(/\s+/) : previous.scopes || [], expiresAt: clock() + t.expires_in * 1000, earliestRefreshAt: typeof t.earliest_refresh_at === 'number' ? t.earliest_refresh_at * 1000 : 0, needsSignIn: false };
  }
  function cancel() {
    if (!pending) return;
    clearTimeout(pending.timer); pending.server.close(); pending = null;
  }
  async function beginLogin({ accountId, newAccount = false } = {}) {
    cancel(); lastError = '';
    const s = read(); store.write(s); // Persist the stable host ID BEFORE opening authorization.
    const previous = newAccount ? null : s.accounts[accountId || s.activeId];
    if (accountId && !previous) throw new Error('Unknown saved ChatGPT account');
    const attempt = { state: random(), nonce: random(), verifier: random(), previous, clientId: previous?.client_id || s.registration?.clientId || '', expiresAt: clock() + 600000, consumed: false };
    if (newAccount) attempt.clientId = '';
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }
      if (req.method !== 'GET' || pending !== attempt || attempt.consumed || clock() > attempt.expiresAt || !same(url.searchParams.get('state'), attempt.state)) { res.writeHead(400); res.end('Invalid or expired sign-in attempt. Return to Amy and try again.'); return; }
      attempt.consumed = true;
      try {
        if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined or could not complete');
        const issued = url.searchParams.get('client_id');
        if (attempt.clientId && issued && issued !== attempt.clientId) throw new Error('OpenAI returned a different client registration');
        const clientId = attempt.clientId || issued;
        if (!clientId || clientId === 'dynamic_agent_client' || !/^[\w-]{8,256}$/.test(clientId)) throw new Error('OpenAI registration did not return a valid issued client ID');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('OpenAI callback did not contain an authorization code');
        // Retain a newly issued registration even if its one-time code exchange fails.
        if (!previous) { const latest = read(); latest.registration = { clientId }; store.write(latest); }
        const t = await tokens({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
        const identity = await verifyIdentity(t.id_token, clientId, attempt.nonce);
        if (previous && identity.sub !== previous.subject) throw new Error('The signed-in account does not match the selected saved account');
        if (pending !== attempt) throw new Error('Sign-in attempt was canceled');
        const id = createHash('sha256').update(`${clientId}|${identity.sub}`).digest('hex').slice(0, 24);
        const a = mergeTokens({ id, client_id: clientId, subject: identity.sub, email: identity.email, name: identity.name }, t);
        const latest = read(); latest.accounts[id] = a; latest.activeId = id; delete latest.registration; store.write(latest);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>ChatGPT connected</h1><p>${a.scopes.includes('chatgpt.tokens.use.direct') ? 'Return to Amy. Her dashboard will check your model access and activate ChatGPT.' : 'Identity connected, but ChatGPT plan usage was not granted. Return to Amy and enable plan usage.'}</p>`);
      } catch (err) {
        lastError = err instanceof ChatGPTError ? err.message : 'ChatGPT sign-in could not be validated. Return to Amy and try again.';
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(lastError);
      } finally { if (pending === attempt) cancel(); else server.close(); }
    });
    attempt.server = server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    attempt.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    attempt.timer = setTimeout(() => { if (pending === attempt) { lastError = 'ChatGPT sign-in timed out. Try again.'; cancel(); } }, 600000); attempt.timer.unref(); server.unref(); pending = attempt;
    const params = new URLSearchParams({ client_id: attempt.clientId || 'dynamic_agent_client', ext_agent_host_id: s.hostId, response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') });
    if (!attempt.clientId) params.set('agent_name_hint', 'Amy Companion');
    if (previous?.id_token) params.set('id_token_hint', previous.id_token);
    return { url: `${ISSUER}/api/accounts/authorize?${params}` };
  }
  async function getAccessToken() {
    const a = account();
    if (!a || a.needsSignIn) throw new Error('Sign in to ChatGPT in dashboard Settings → Brain');
    if (!a.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage was not authorized. Reconnect and enable plan usage');
    if (a.expiresAt > clock() + 60000 || (a.earliestRefreshAt > clock() && a.expiresAt > clock())) return a.access_token;
    if (!a.refresh_token) throw new Error('ChatGPT sign-in expired. Reconnect in the dashboard');
    if (!refreshes.has(a.id)) refreshes.set(a.id, (async () => {
      try {
        const renew = async () => {
          const current = read().accounts[a.id];
          if (!current || current.needsSignIn || !current.refresh_token) throw new Error('ChatGPT account was disconnected during renewal');
          if (current.expiresAt > clock() + 60000 && current.scopes.includes('chatgpt.tokens.use.direct')) return current.access_token;
          const t = await tokens({ grant_type: 'refresh_token', client_id: current.client_id, refresh_token: current.refresh_token, resource: RESOURCE });
          const latest = read();
          if (!latest.accounts[a.id] || latest.accounts[a.id].refresh_token !== current.refresh_token) throw new Error('ChatGPT account changed during token refresh');
          const updated = mergeTokens(current, t); latest.accounts[a.id] = updated; store.write(latest);
          if (!updated.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage permission is no longer granted');
          return updated.access_token;
        };
        return await (store.withLock ? store.withLock(renew) : renew());
      } catch (err) {
        if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(err.code)) {
          const latest = read(); if (latest.accounts[a.id]) { latest.accounts[a.id].needsSignIn = true; delete latest.accounts[a.id].access_token; delete latest.accounts[a.id].refresh_token; store.write(latest); }
        }
        throw err;
      } finally { refreshes.delete(a.id); }
    })());
    const token = await refreshes.get(a.id);
    if (account()?.id !== a.id) return getAccessToken();
    return token;
  }
  async function models() {
    const selectedId = account()?.id;
    if (catalogCache?.accountId === selectedId && clock() - catalogCache.at < 300000) return catalogCache.models;
    const token = await getAccessToken();
    const res = await fetchImpl(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!res.ok) throw await openAIError(res);
    const data = await res.json();
    if (!Array.isArray(data.models)) throw new Error('OpenAI returned an unexpected subscription model catalog');
    const models = data.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string' && !/codex/i.test(m.slug)).map((m) => ({ id: m.slug, name: m.display_name || m.slug, context: Number(m.context_length || m.context_window) || 0, vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : null }));
    if (account()?.id !== selectedId) throw new Error('ChatGPT account changed during model discovery');
    catalogCache = { accountId: selectedId, at: clock(), models };
    return models;
  }
  function selectAccount(id) { cancel(); const s = read(); if (!s.accounts[id]) throw new Error('Unknown saved ChatGPT account'); s.activeId = id; store.write(s); return status(); }
  async function disconnect() {
    catalogCache = null;
    cancel(); const a = account(); if (!a) return { revoked: true };
    let revoked = false;
    try {
      const metadata = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
      const endpoint = new URL(metadata.revocation_endpoint);
      if (endpoint.origin !== ISSUER) throw new Error('Unexpected revocation host');
      const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.refresh_token || '', token_type_hint: 'refresh_token', client_id: a.client_id }), signal: AbortSignal.timeout(15000), redirect: 'error' });
      revoked = res.status === 200;
    } catch { /* Still stop using local credentials; clearly report unconfirmed remote revocation. */ }
    const s = read(); if (s.accounts[a.id]) { s.accounts[a.id] = { ...s.accounts[a.id], access_token: undefined, refresh_token: undefined, id_token: undefined, needsSignIn: true }; store.write(s); }
    return { revoked, message: revoked ? 'ChatGPT disconnected.' : 'Disconnected locally. Remote revocation was not confirmed; disconnect Amy in ChatGPT Settings → Usage.' };
  }
  return { status, beginLogin, cancel, getAccessToken, models, selectAccount, disconnect };
}

export const chatgptAuth = createChatGPTAuth();
