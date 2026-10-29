import test from 'node:test';
import assert from 'node:assert/strict';
import { setTone, voiceIdFor, currentTone, HOLD_MS, STRONG_MS, PIN_MS } from './tone.js';

const config = { tts: 'fish', fish: { voiceId: 'normal-id', strongVoiceId: 'strong-id' } };
let n = 0;
const conv = () => `voice:test-${++n}`;
const T = 1_000_000;

test('starts normal and speaks with the existing voice', () => {
  const c = conv();
  assert.equal(currentTone(c, T).tone, 'normal');
  assert.equal(voiceIdFor(c, config, T), 'normal-id');
});

test('strong needs a reason, then uses the second voice and wears off by itself', () => {
  const c = conv();
  assert.throws(() => setTone(c, { action: 'strong' }, { config, now: T }), /Say why/);
  setTone(c, { action: 'strong', reason: 'sustained frustration' }, { config, now: T });
  assert.equal(voiceIdFor(c, config, T + 1000), 'strong-id');
  assert.equal(voiceIdFor(c, config, T + STRONG_MS + 1), 'normal-id');
});

test('her own switches are held, so no rapid back-and-forth', () => {
  const c = conv();
  setTone(c, { action: 'strong', reason: 'serious' }, { config, now: T });
  assert.throws(() => setTone(c, { action: 'normal' }, { config, now: T + 60_000 }), /keep your strong voice/);
  setTone(c, { action: 'normal' }, { config, now: T + HOLD_MS });
  assert.equal(voiceIdFor(c, config, T + HOLD_MS), 'normal-id');
});

test('owner override applies at once, pins the voice, and auto hands it back', () => {
  const c = conv();
  setTone(c, { action: 'strong', reason: 'serious' }, { config, now: T });
  setTone(c, { action: 'normal', override: true }, { config, owner: true, now: T + 1000 });
  assert.equal(voiceIdFor(c, config, T + 1000), 'normal-id');
  assert.throws(() => setTone(c, { action: 'strong', reason: 'x' }, { config, now: T + HOLD_MS + 2000 }), /pinned/);
  setTone(c, { action: 'auto' }, { config, owner: true, now: T + 5000 });
  setTone(c, { action: 'strong', reason: 'x' }, { config, now: T + HOLD_MS + 2000 });
  assert.equal(voiceIdFor(c, config, T + HOLD_MS + 2000), 'strong-id');
});

test('an owner-forced strong voice lasts as long as the pin', () => {
  const c = conv();
  setTone(c, { action: 'strong', override: true }, { config, owner: true, now: T });
  assert.equal(voiceIdFor(c, config, T + STRONG_MS + 1), 'strong-id');
  assert.equal(voiceIdFor(c, config, T + PIN_MS + 1), 'normal-id');
});

test('only the owner can override or hand back, and an unset or non-Fish voice is refused', () => {
  const c = conv();
  assert.throws(() => setTone(c, { action: 'strong', override: true }, { config, now: T }), /owner/);
  assert.throws(() => setTone(c, { action: 'auto' }, { config, now: T }), /owner/);
  const unset = { tts: 'fish', fish: { voiceId: 'normal-id', strongVoiceId: '' } };
  assert.throws(() => setTone(c, { action: 'strong', reason: 'x' }, { config: unset, now: T }), /dashboard/);
  assert.throws(() => setTone(c, { action: 'strong', reason: 'x' }, { config: { ...config, tts: 'kokoro' }, now: T }), /local engine/);
  assert.equal(voiceIdFor(c, unset, T), 'normal-id');
});
