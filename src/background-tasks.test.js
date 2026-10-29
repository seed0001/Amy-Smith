import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, toolFailed } from './tools.js';
import { config } from './config.js';
import { runningHelpers } from './agents.js';

test('several background helpers can run at once, within a cap, and a repeated brief is not started twice', async t => {
  const key = config.openrouter.apiKey, realFetch = globalThis.fetch;
  t.after(() => { config.openrouter.apiKey = key; globalThis.fetch = realFetch; });
  config.openrouter.apiKey = 'unused-test-key';
  // The helpers' model calls never answer, so they stay running and nothing is paid for or saved.
  let requests = 0;
  globalThis.fetch = () => { requests++; return new Promise(() => {}); };
  const ctx = { conversation: 'background-test', perms: { owner: true, files: true }, sendHere: () => {} };
  const start = (n) => runTool('background_task', { action: 'start', title: `Job ${n}`, instructions: `Brief number ${n}` }, ctx);

  const first = await start(1);
  const second = await start(2);
  assert.match(first, /Started background task #\d+/);
  assert.match(second, /Started background task #\d+/);
  assert.equal(runningHelpers().length, 2);
  assert.equal(requests, 2);

  const again = await start(1);
  assert.match(again, /already working on that brief/);
  assert.equal(runningHelpers().length, 2);

  await start(3);
  await start(4);
  assert.equal(runningHelpers().length, 4);
  const over = await start(5);
  assert.equal(toolFailed(over), true);
  assert.match(over, /already running/);
  assert.equal(runningHelpers().length, 4);
});
