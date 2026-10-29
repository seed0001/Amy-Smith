import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFailover, isCreditLimit, providerRequestError } from './provider-failover.js';
import { chat } from './llm.js';

const quota = (provider) => Object.assign(new Error('budget exhausted'), provider === 'chatgpt' ? { status: 429, code: 'subscription_sharing_usage_limit_exceeded' } : { status: 402 });
function fixture({ primary = 'openrouter', configured = () => true, enabled = true, initial = {} } = {}) {
  let now = 1000000, persisted;
  const switches = [];
  const router = createProviderFailover({ preferred: () => primary, configured, enabled: () => enabled, model: (p) => `${p}-model`, clock: () => now, load: () => initial, save: (s) => { persisted = s; }, onSwitch: async (e) => { switches.push(e); } });
  return { router, switches, advance: (ms) => now += ms, persisted: () => persisted };
}

test('credit exhaustion is distinct from ordinary throttling, auth, validation and network errors', () => {
  assert.equal(isCreditLimit(quota('openrouter'), 'openrouter'), true);
  assert.equal(isCreditLimit(quota('chatgpt'), 'chatgpt'), true);
  for (const error of [{ status: 429, code: 'rate_limit_exceeded' }, { status: 401 }, { status: 400 }, new Error('network timeout')]) {
    assert.equal(isCreditLimit(error, 'openrouter'), false); assert.equal(isCreditLimit(error, 'chatgpt'), false);
  }
  const nested = providerRequestError({ error: { code: 402, message: 'Insufficient credits' } }, 'openrouter');
  assert.equal(isCreditLimit(nested, 'openrouter'), true);
});

test('either cloud provider falls back to the other and announces only actual switches', async () => {
  for (const primary of ['openrouter', 'chatgpt']) {
    const f = fixture({ primary }), calls = [];
    const other = primary === 'openrouter' ? 'chatgpt' : 'openrouter';
    const run = async (p) => { calls.push(p); if (p === primary) throw quota(p); return 'answer'; };
    assert.equal(await f.router.execute(run), 'answer');
    assert.deepEqual(calls, [primary, other]);
    assert.equal(f.switches[0].to, other);
    await f.router.execute(run);
    assert.equal(f.switches.length, 1);
    assert.equal(f.router.status().active.provider, other);
  }
});

test('both exhausted cloud providers lead to local exactly once, without looping', async () => {
  const f = fixture(), calls = [];
  const value = await f.router.execute(async (p) => { calls.push(p); if (p !== 'ollama') throw quota(p); return { local: true }; });
  assert.deepEqual(calls, ['openrouter', 'chatgpt', 'mistral', 'ollama']);
  assert.equal(value.local, true);
  assert.equal(f.switches.length, 1);
  assert.match(f.switches[0].message, /All the cloud providers/);
  assert.equal(f.switches[0].to, 'ollama');
});

test('disabled failover and non-credit errors never call another provider', async () => {
  for (const options of [{ enabled: false }, {}]) {
    const f = fixture(options), calls = [];
    await assert.rejects(f.router.execute(async (p) => { calls.push(p); throw options.enabled === false ? quota(p) : Object.assign(new Error('bad schema'), { status: 400 }); }));
    assert.deepEqual(calls, ['openrouter']);
  }
});

test('missing backup is skipped and an explicitly selected local provider stays local', async () => {
  const f = fixture({ configured: (p) => p === 'openrouter' }), calls = [];
  await f.router.execute(async (p) => { calls.push(p); if (p === 'openrouter') throw quota(p); return 'local'; });
  assert.deepEqual(calls, ['openrouter', 'ollama']);
  const local = fixture({ primary: 'ollama' });
  await local.router.execute(async (p) => { assert.equal(p, 'ollama'); return 'local'; });
});

test('cooldown persists across restart and cloud recovery is retried on a later request', async () => {
  const f = fixture();
  await f.router.execute(async (p) => { if (p !== 'ollama') throw quota(p); return 'local'; });
  const restored = fixture({ initial: f.persisted() }), tried = [];
  await restored.router.execute(async (p) => { tried.push(p); return 'still local'; });
  assert.deepEqual(tried, ['ollama']);
  restored.advance(16 * 60000);
  await restored.router.execute(async (p) => { assert.equal(p, 'openrouter'); return 'restored'; });
  assert.equal(restored.router.status().active.provider, 'openrouter');
  assert.match(restored.switches[0].message, /available/);
});

test('stream fallback continues after partial text and retains completed tool results', async () => {
  const f = fixture(), seenHistory = [], parts = [];
  const messages = [{ role: 'tool', tool_call_id: 'already_done', content: 'saved successfully' }];
  async function* run(p, history) {
    seenHistory.push(history);
    if (p === 'openrouter') { yield { message: { content: 'First point. ' } }; throw quota(p); }
    yield { message: { content: 'Second point.' } };
    yield { message: { content: '' }, responseOutput: [{ type: 'message', role: 'assistant', content: [] }] };
  }
  for await (const part of f.router.stream(messages, run)) parts.push(part);
  assert.equal(parts.map((p) => p.message.content).join(''), 'First point. Second point.');
  assert.equal(seenHistory[1][0].tool_call_id, 'already_done');
  assert.equal(seenHistory[1].at(-2).content, 'First point. ');
  assert.match(seenHistory[1].at(-1).content, /without repeating/);
  assert.equal(parts.at(-1).responseOutput[0].content, 'First point. ');
});

test('failed stream tool calls are discarded rather than executed alongside the backup tools', async () => {
  const f = fixture(), parts = [];
  async function* run(p) {
    if (p === 'openrouter') { yield { message: { tool_calls: [{ id: 'failed', function: { name: 'write_file' } }] } }; throw quota(p); }
    yield { message: { content: 'Recovered.' } };
  }
  for await (const part of f.router.stream([], run)) parts.push(part);
  assert.equal(parts.some((p) => p.message.tool_calls), false);
});

test('main tool loop does not re-execute a completed action after provider exhaustion', async () => {
  const f = fixture(); let executions = 0, primaryRounds = 0;
  async function* run(p) {
    if (p === 'openrouter' && primaryRounds++ === 0) { yield { message: { tool_calls: [{ id: 'done', function: { name: 'save_file', arguments: '{}' } }] } }; return; }
    if (p === 'openrouter') throw quota(p);
    yield { message: { content: 'Saved successfully.' } };
  }
  const text = await chat([{ role: 'user', content: 'save it' }], { tools: [{ function: { name: 'save_file' } }], runTool: async () => { executions++; return 'saved'; }, streamFactory: (history) => f.router.stream(history, run) });
  assert.equal(text, 'Saved successfully.'); assert.equal(executions, 1);
});

test('mistral: only the monthly allowance counts as a usage limit, not the per-second rate limit', () => {
  assert.equal(isCreditLimit(Object.assign(new Error('Mistral: Requests rate limit exceeded'), { status: 429 }), 'mistral'), false);
  assert.equal(isCreditLimit(Object.assign(new Error('Mistral: Monthly token quota exceeded'), { status: 429 }), 'mistral'), true);
  assert.equal(isCreditLimit(Object.assign(new Error('Mistral: payment required'), { status: 402 }), 'mistral'), true);
});
