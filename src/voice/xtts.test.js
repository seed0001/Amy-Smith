import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { xttsSamples, xttsReference, xttsAvailability, XTTSWorker } from './xtts.js';
import { ttsReady } from './provider.js';

function fixture(t) {
  const root = path.resolve(tmpdir()), folder = mkdtempSync(path.join(root, 'champ-xtts-test-'));
  t.after(() => { if (path.dirname(path.resolve(folder)) !== root) throw new Error('Unexpected cleanup path'); rmSync(folder, { recursive: true, force: true }); });
  const settings = { python: path.join(folder, 'python.exe'), modelDir: path.join(folder, 'model'), referenceDir: path.join(folder, 'voices'), reference: '', language: 'en', speed: 1 };
  mkdirSync(settings.modelDir); mkdirSync(settings.referenceDir);
  writeFileSync(settings.python, 'fake');
  for (const file of ['config.json', 'model.pth', 'vocab.json', 'speakers_xtts.pth']) writeFileSync(path.join(settings.modelDir, file), 'test');
  return settings;
}

test('XTTS requires its own sample even when a Fish API key exists', (t) => {
  const settings = fixture(t);
  assert.equal(xttsAvailability(settings).installed, true);
  assert.equal(xttsAvailability(settings).ready, false);
  assert.equal(ttsReady({ tts: 'xtts', xtts: settings, fish: { apiKey: 'present' } }), false);
  writeFileSync(path.join(settings.referenceDir, 'reference.wav'), Buffer.alloc(100));
  assert.equal(xttsAvailability(settings).ready, true);
});

test('sample discovery ignores non-audio files, prefers reference.wav, and rejects traversal', (t) => {
  const settings = fixture(t);
  writeFileSync(path.join(settings.referenceDir, 'README.txt'), 'instructions');
  writeFileSync(path.join(settings.referenceDir, 'other.mp3'), Buffer.alloc(100));
  writeFileSync(path.join(settings.referenceDir, 'reference.wav'), Buffer.alloc(100));
  assert.deepEqual(xttsSamples(settings), ['other.mp3', 'reference.wav']);
  assert.equal(path.basename(xttsReference(settings)), 'reference.wav');
  assert.equal(path.basename(xttsReference({ ...settings, reference: 'other.mp3' })), 'other.mp3');
  assert.equal(xttsReference({ ...settings, reference: '../other.mp3' }), null);
  assert.equal(xttsReference({ ...settings, reference: 'missing.wav' }), null);
});

test('worker keeps a single hidden subprocess and associates split replies with request IDs', async (t) => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  let starts = 0;
  const worker = new XTTSWorker({ python: 'python', modelDir: 'model' }, { spawnImpl: (_exe, args, options) => { starts++; assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.ok(args.includes('--model-dir')); return child; } });
  t.after(() => worker.stop());
  const requests = [];
  child.stdin.on('data', (data) => requests.push(JSON.parse(data.toString())));
  const first = worker.request('warmup'), second = worker.request('synthesize', { text: 'test' });
  const line = JSON.stringify({ id: requests[1].id, ok: true, audio: 'abc' }) + '\n';
  child.stdout.write(line.slice(0, 8)); child.stdout.write(line.slice(8));
  child.stdout.write(JSON.stringify({ id: requests[0].id, ok: true, ready: true }) + '\n');
  assert.equal((await first).ready, true); assert.equal((await second).audio, 'abc');
  assert.equal(starts, 1);
});

test('worker failures reject pending synthesis instead of hanging', async (t) => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const worker = new XTTSWorker({ python: 'python', modelDir: 'model' }, { spawnImpl: () => child });
  t.after(() => worker.stop());
  const pending = worker.request('warmup');
  const rejected = assert.rejects(pending, /exited/);
  child.emit('exit', 1);
  await rejected;
});
