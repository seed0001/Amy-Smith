import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderNarration } from './provider-narration.js';

test('switch narration uses the current voice or avatar sentence callback once', async () => {
  const spoken = [], background = [];
  const n = createProviderNarration({ background: (e) => background.push(e) });
  await n.run((text) => spoken.push(text), async () => n.announce({ message: 'Switching providers.' }));
  assert.deepEqual(spoken, ['Switching providers.']); assert.equal(background.length, 0);
});

test('background/text switches are broadcast for active voice sessions', async () => {
  const heard = [];
  const n = createProviderNarration({ background: (e) => heard.push(e.message) });
  await n.run(null, () => n.announce({ message: 'Switching to local.' }));
  assert.deepEqual(heard, ['Switching to local.']);
});

test('concurrent conversations retain their own narration targets', async () => {
  const first = [], second = [];
  const n = createProviderNarration();
  await Promise.all([
    n.run((text) => first.push(text), async () => { await new Promise((r) => setTimeout(r, 5)); await n.announce({ message: 'first' }); }),
    n.run((text) => second.push(text), async () => n.announce({ message: 'second' })),
  ]);
  assert.deepEqual(first, ['first']); assert.deepEqual(second, ['second']);
});

test('narration can be disabled without calling speech or background targets', async () => {
  let called = false;
  const n = createProviderNarration({ enabled: () => false, background: () => { called = true; } });
  await n.run(() => { called = true; }, () => n.announce({ message: 'switch' }));
  assert.equal(called, false);
});

test('a detached memory task uses background narration after its original reply finishes', async () => {
  const spoken = [], background = [];
  const n = createProviderNarration({ background: (e) => background.push(e.message) });
  let detached;
  await n.run((text) => spoken.push(text), () => {
    detached = new Promise((resolve) => setTimeout(async () => { await n.announce({ message: 'background switch' }); resolve(); }, 5));
  });
  await detached;
  assert.deepEqual(spoken, []); assert.deepEqual(background, ['background switch']);
});
