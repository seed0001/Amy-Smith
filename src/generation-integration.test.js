import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, toolFailed } from './tools.js';
import { config } from './config.js';
import { listTasks, cancelTask } from './agents.js';
import { toolQueued } from './generation-jobs.js';

test('permissions and image routing reject requests before spawning any generation sub-agent', async t => {
  const key = config.openrouter.apiKey;
  t.after(() => { config.openrouter.apiKey = key; });
  config.openrouter.apiKey = 'unused-test-key';
  const before = listTasks().length;
  const denied = await runTool('generate_image', { prompt: 'dragon' }, { perms: {}, sendHere: () => assert.fail('delivery forbidden') });
  assert.equal(toolFailed(denied), true);
  const wrongRoute = await runTool('generate_image', { prompt: 'portrait of you' }, {
    perms: { files: true }, userText: 'draw yourself', character: { name: 'Amy', main: true }, sendHere: () => assert.fail('wrong pipeline'),
  });
  assert.equal(toolFailed(wrongRoute), true);
  assert.match(wrongRoute, /generate_self_image/);
  assert.equal(listTasks().length, before);
});

test('generation tool returns a queued receipt and cancellation stops the job before any paid request', async t => {
  const key = config.openrouter.apiKey;
  t.after(() => { config.openrouter.apiKey = key; });
  config.openrouter.apiKey = 'unused-test-key';
  const result = await runTool('generate_image', { prompt: 'dragon' }, {
    turn: 'generation-cancel-test', conversation: 'generation-test', perms: { files: true },
    sendHere: () => assert.fail('cancelled generation must not deliver'),
  });
  assert.equal(toolQueued(result), true);
  const id = Number(result.match(/#(\d+)/)[1]);
  assert.equal(cancelTask(id), true);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listTasks().find(task => task.id === id).status, 'cancelled');
});
