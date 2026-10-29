import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTurnPlan, controlTurnClassifier } from './turn-routing.js';

test('enabled classifier runs once and records its duration', async () => {
  let calls = 0, time = 0;
  const result = await chooseTurnPlan({ plan: async () => { calls++; return { tools: ['web_search'], search: 'weather' }; }, now: () => time += 5 });
  assert.equal(calls, 1);
  assert.equal(result.classifierMs, 5);
  assert.equal(result.routingMode, 'classifier_advisory');
  assert.deepEqual(result.tools, ['web_search']);
});

for (const options of [{ enabled: false }, { cue: true }, { hasActions: false }]) {
  test(`planner is bypassed for ${JSON.stringify(options)}`, async () => {
    const result = await chooseTurnPlan({ ...options, plan: () => assert.fail('planner must not run') });
    assert.deepEqual(result.tools, []);
    assert.equal(result.search, null);
    assert.equal(result.classifierMs, 0);
  });
}

test('natural language control saves off and on; status does not write', () => {
  const config = { turnClassifierEnabled: true }, writes = [], events = [];
  const ctx = { config, updateSettings: patch => { writes.push(patch); Object.assign(config, patch); }, activity: (...args) => events.push(args) };
  assert.match(controlTurnClassifier({ action: 'off' }, ctx), /pass is off/);
  assert.equal(config.turnClassifierEnabled, false);
  assert.match(controlTurnClassifier({ action: 'status' }, ctx), /pass is off/);
  assert.equal(writes.length, 1);
  assert.match(controlTurnClassifier({ action: 'on' }, ctx), /pass is on/);
  assert.equal(config.turnClassifierEnabled, true);
  assert.equal(writes.length, 2);
  assert.equal(events.length, 2);
  assert.throws(() => controlTurnClassifier({ action: 'delete' }, ctx));
  assert.equal(writes.length, 2);
});
