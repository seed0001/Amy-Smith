import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationDispatcher, isGenerationTool, toolQueued } from './generation-jobs.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('generation policy covers both image pipelines, music and appearance generation only', () => {
  for (const name of ['generate_image', 'generate_self_image', 'generate_music']) assert.equal(isGenerationTool(name), true);
  for (const action of ['setup', 'new']) assert.equal(isGenerationTool('look', { action }), true);
  for (const action of ['wear', 'send', 'reference', 'list']) assert.equal(isGenerationTool('look', { action }), false);
  assert.equal(isGenerationTool('web_search'), false);
  assert.equal(toolQueued('[generate_image: queued]\nStarted'), true);
  assert.equal(toolQueued('[generate_image: ok]\nDelivered'), false);
});

test('handoff returns immediately, snapshots permissions, and deduplicates same-turn calls', async () => {
  const gate = deferred(); let brief, calls = 0;
  const dispatch = createGenerationDispatcher({ startTask: options => { brief = options; return { id: 1 }; }, runTool: async (_name, _args, ctx) => {
    calls++; assert.equal(ctx.generationJob, true); assert.equal(ctx.perms.files, true);
    await gate.promise; return '[generate_image: ok]\nDelivered';
  } });
  const ctx = { turn: 'turn1', conversation: 'test', perms: { files: true }, sendHere: () => {} };
  const receipt = dispatch('generate_image', { prompt: 'dragon' }, ctx);
  assert.match(receipt, /still working/);
  assert.equal(calls, 0);
  assert.equal(dispatch('generate_image', { prompt: 'dragon' }, ctx), receipt);
  ctx.perms.files = false;
  const job = brief.execute({ cancel: false, actions: [], steps: 0 });
  await tick(); assert.equal(calls, 1);
  gate.resolve(); assert.match(await job, /Delivered/);
});

test('sub-agent uses durable delivery rather than a finished reply attachment array', async () => {
  let brief; const delivered = [];
  const dispatch = createGenerationDispatcher({ startTask: options => { brief = options; return { id: 2 }; }, runTool: async (_name, _args, ctx) => {
    await ctx.sendHere('image'); return '[generate_image: ok]';
  } });
  dispatch('generate_image', { prompt: 'cat' }, { perms: { files: true }, sendHere: () => assert.fail('expired reply callback'), sendBackground: file => delivered.push(file) });
  await brief.execute({ cancel: false, actions: [] });
  assert.deepEqual(delivered, ['image']);
});

test('failures propagate to task state; cancellation prevents late delivery', async () => {
  const briefs = [], gate = deferred(); let sent = false;
  const dispatch = createGenerationDispatcher({ startTask: options => { briefs.push(options); return { id: briefs.length }; }, runTool: async (name, _args, ctx) => {
    if (name === 'generate_music') return '[generate_music: error unavailable] quota exhausted';
    await gate.promise; await ctx.sendHere('image'); return '[generate_image: ok]';
  } });
  dispatch('generate_music', {}, { perms: {} });
  await assert.rejects(briefs[0].execute({ cancel: false, actions: [] }), /quota exhausted/);
  dispatch('generate_image', {}, { perms: {}, sendHere: () => { sent = true; } });
  const task = { cancel: false, actions: [] }, running = briefs[1].execute(task);
  task.cancel = true; gate.resolve();
  await assert.rejects(running, /cancelled/);
  assert.equal(sent, false);
});

test('at most two generation sub-agents run at once and queue is bounded', async () => {
  const briefs = [], gate = deferred(); let running = 0, peak = 0;
  const dispatch = createGenerationDispatcher({ startTask: options => { briefs.push(options); return { id: briefs.length }; }, runTool: async () => {
    running++; peak = Math.max(peak, running); await gate.promise; running--; return '[generate_image: ok]';
  } });
  for (let i = 0; i < 12; i++) dispatch('generate_image', { prompt: String(i) }, { perms: {} });
  assert.throws(() => dispatch('generate_image', { prompt: 'overflow' }, { perms: {} }), /queue is full/);
  const jobs = briefs.map(brief => brief.execute({ cancel: false, actions: [] }));
  await tick(); assert.equal(running, 2);
  gate.resolve(); await Promise.all(jobs); assert.equal(peak, 2);
});

test('completion updates conversation before notifying the original destination', async () => {
  let brief; const events = [];
  const dispatch = createGenerationDispatcher({ startTask: options => { brief = options; return { id: 3 }; }, runTool: () => {}, completed: () => events.push('history') });
  dispatch('generate_image', {}, { perms: {}, notify: () => events.push('notify') });
  await brief.notify('Done', { status: 'done' });
  assert.deepEqual(events, ['history', 'notify']);
});
