import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopRequest, continuationReady } from './interruption.js';

test('direct stop requests cancel, quoted or discussed commands do not', () => {
  for (const text of ['stop', 'Stop talking.', 'please stop talking now', 'Amy, be quiet', 'shut up', 'enough']) {
    assert.equal(isStopRequest(text), true, text);
  }
  for (const text of ['she told him to stop talking', 'do not stop talking', 'why did you stop talking?', 'stop the music', 'how do I stop talking over people?']) {
    assert.equal(isStopRequest(text), false, text);
  }
});

test('continuation waits for human and bot silence and all work to finish', () => {
  const idle = { pending: 0, speaking: false, pumping: false, speech: [], listening: new Set(), transcribing: 0, lastHeard: 1000, lastSpoke: 2000 };
  assert.equal(continuationReady(idle, 10000), true);
  assert.equal(continuationReady(idle, 9999), false);
  for (const change of [{ pending: 1 }, { speaking: true }, { pumping: true }, { speech: [{}] }, { listening: new Set(['person']) }, { transcribing: 1 }, { destroyed: true }, { lastHeard: 9000 }]) {
    assert.equal(continuationReady({ ...idle, ...change }, 10000), false);
  }
});
