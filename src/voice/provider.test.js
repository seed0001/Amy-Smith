import test from 'node:test';
import assert from 'node:assert/strict';
import { changeVoice, ttsReady } from './provider.js';

function fixture({ key = 'test-key', engine = 'fish', failLoad = false } = {}) {
  const config = { tts: engine, fish: { apiKey: key, ttsModel: 'test', voiceId: 'test' }, kokoro: { voice: 'af_heart', speed: 1 }, xtts: { reference: '', language: 'en', speed: 1 } };
  const patches = [];
  let loads = 0;
  const deps = { config, activity() {}, async voices() { loads++; if (failLoad) throw new Error('model unavailable'); return ['af_heart', 'af_bella']; }, updateSettings(patch) {
    patches.push(patch); config.tts = patch.ttsProvider;
    if (patch.kokoroVoice) config.kokoro.voice = patch.kokoroVoice;
    if (patch.kokoroSpeed) config.kokoro.speed = patch.kokoroSpeed;
    if (patch.xttsReference) config.xtts.reference = patch.xttsReference;
    if (patch.xttsSpeed) config.xtts.speed = patch.xttsSpeed;
  } };
  return { deps, config, patches, loads: () => loads };
}

test('switch to local without a Fish key and persist one validated patch', async () => {
  const f = fixture({ key: '' });
  const result = await changeVoice({ action: 'set', engine: 'local' }, f.deps);
  assert.match(result, /Kokoro/);
  assert.deepEqual(f.patches, [{ ttsProvider: 'kokoro' }]);
  assert.equal(ttsReady(f.config), true);
});

test('Fish selection needs a key and does not load the local model', async () => {
  const missing = fixture({ key: '', engine: 'kokoro' });
  await assert.rejects(changeVoice({ action: 'set', engine: 'fish' }, missing.deps), /API key/);
  assert.equal(missing.patches.length, 0);
  const ready = fixture({ engine: 'kokoro' });
  assert.match(await changeVoice({ action: 'set', engine: 'Fish Audio' }, ready.deps), /Fish Audio/);
  assert.equal(ready.loads(), 0);
});

test('a preset voice implies Kokoro and speed is saved atomically', async () => {
  const f = fixture();
  await changeVoice({ action: 'set', voice: 'af_bella', speed: 1.2 }, f.deps);
  assert.deepEqual(f.patches, [{ ttsProvider: 'kokoro', kokoroVoice: 'af_bella', kokoroSpeed: 1.2 }]);
});

test('unknown providers, bad voices, invalid speed and local load failures leave settings intact', async () => {
  for (const args of [{ engine: 'unknown' }, { engine: 'kokoro', voice: 'missing' }, { engine: 'kokoro', speed: 3 }, { engine: 'kokoro', speed: -1 }, { engine: 'fish', voice: 'af_heart' }, {}]) {
    const f = fixture();
    await assert.rejects(changeVoice({ action: 'set', ...args }, f.deps));
    assert.equal(f.patches.length, 0);
  }
  const f = fixture({ failLoad: true });
  await assert.rejects(changeVoice({ action: 'set', engine: 'kokoro' }, f.deps), /model unavailable/);
  assert.equal(f.config.tts, 'fish');
  assert.equal(f.patches.length, 0);
});

test('status and provider list are read-only and do not load Kokoro', async () => {
  const f = fixture();
  assert.match(await changeVoice({}, f.deps), /Fish Audio/);
  assert.match(await changeVoice({ action: 'providers' }, f.deps), /Fish Audio.*Kokoro/);
  assert.equal(f.loads(), 0);
  assert.equal(f.patches.length, 0);
  assert.equal(ttsReady({ tts: 'fish', fish: { apiKey: '' } }), false);
});

test('XTTS selects a local sample and speed only after its runtime/sample validation succeeds', async () => {
  const f = fixture({ key: '' }); let prepared;
  f.deps.xttsVoices = () => ['reference.wav'];
  f.deps.prepareXTTS = async (settings) => { prepared = settings; };
  const result = await changeVoice({ action: 'set', engine: 'xtts', voice: 'reference.wav', speed: 1.1 }, f.deps);
  assert.equal(prepared.reference, 'reference.wav');
  assert.equal(prepared.speed, 1.1);
  assert.deepEqual(f.patches, [{ ttsProvider: 'xtts', xttsReference: 'reference.wav', xttsSpeed: 1.1 }]);
  assert.match(result, /XTTS/);
  assert.equal(f.loads(), 0);
});

test('XTTS missing or invalid sample leaves the existing provider unchanged', async () => {
  const f = fixture();
  f.deps.xttsVoices = () => [];
  f.deps.prepareXTTS = async () => { throw new Error('Add your voice sample'); };
  await assert.rejects(changeVoice({ action: 'set', engine: 'xtts' }, f.deps), /voice sample/);
  await assert.rejects(changeVoice({ action: 'set', engine: 'xtts', voice: 'missing.wav' }, f.deps), /Unknown XTTS/);
  assert.equal(f.patches.length, 0);
  assert.equal(f.config.tts, 'fish');
});

test('XTTS voice listing and status do not load either speech model', async () => {
  const f = fixture({ engine: 'xtts' });
  f.deps.xttsVoices = () => ['reference.wav'];
  assert.match(await changeVoice({ action: 'voices', engine: 'xtts' }, f.deps), /reference.wav/);
  assert.match(await changeVoice({ action: 'status' }, f.deps), /XTTS/);
  assert.equal(f.loads(), 0);
});
