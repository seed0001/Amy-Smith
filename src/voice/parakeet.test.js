import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ParakeetWorker, parakeetAvailable } from './parakeet.js';
import { sttEngine } from './stt.js';
import { config } from '../config.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => {};
  let starts = 0;
  const worker = new ParakeetWorker({ python: 'python', modelDir: 'model', threads: 4 }, {
    spawnImpl: (_exe, args, options) => {
      starts++;
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.equal(options.env.HF_HUB_OFFLINE, '1');
      assert.ok(args.includes('--threads'));
      return child;
    },
  });
  t.after(() => worker.stop());
  const requests = [];
  child.stdin.on('data', data => requests.push(JSON.parse(data.toString())));
  return { child, worker, requests, starts: () => starts };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Parakeet reuses one hidden process and serializes overlapping speakers', async t => {
  const f = fixture(t);
  const first = f.worker.transcribe(Buffer.alloc(96)), second = f.worker.transcribe(Buffer.alloc(100));
  await tick();
  assert.equal(f.requests.length, 1);
  const reply = JSON.stringify({ id: f.requests[0].id, ok: true, text: 'First.', ms: 12 }) + '\n';
  f.child.stdout.write(reply.slice(0, 9)); f.child.stdout.write(reply.slice(9));
  assert.equal((await first).text, 'First.');
  await tick();
  assert.equal(f.requests.length, 2);
  assert.equal(Buffer.from(f.requests[1].pcm, 'base64').length, 96);
  f.child.stdout.write(JSON.stringify({ id: f.requests[1].id, ok: true, text: 'Second.' }) + '\n');
  assert.equal((await second).text, 'Second.');
  assert.equal(f.starts(), 1);
});

test('worker exits reject requests and allow the next utterance to retry', async t => {
  const f = fixture(t);
  const failed = assert.rejects(f.worker.transcribe(Buffer.alloc(96)), /exited/);
  await tick(); f.child.emit('exit', 1); await failed;
  const next = f.worker.transcribe(Buffer.alloc(96));
  await tick();
  f.child.stdout.write(JSON.stringify({ id: f.requests.at(-1).id, ok: true, text: 'Recovered.' }) + '\n');
  assert.equal((await next).text, 'Recovered.');
  assert.equal(f.starts(), 2);
});

test('invalid responses and invalid audio fail clearly', async t => {
  const f = fixture(t);
  await assert.rejects(f.worker.transcribe(Buffer.alloc(3)), /PCM16/);
  await assert.rejects(f.worker.transcribe(Buffer.alloc(0)), /PCM16/);
  await assert.rejects(f.worker.transcribe(Buffer.alloc(48000 * 2 * 121)), /PCM16/);
  assert.equal(f.starts(), 0);
  const failed = assert.rejects(f.worker.transcribe(Buffer.alloc(96)), /invalid data/);
  await tick(); f.child.stdout.write('not json\n'); await failed;
});

test('availability requires the runtime and every model component', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'amy-parakeet-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = { python: path.join(root, 'python.exe'), modelDir: path.join(root, 'model') };
  mkdirSync(settings.modelDir);
  assert.equal(parakeetAvailable(settings), false);
  writeFileSync(settings.python, 'fixture');
  for (const file of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx']) writeFileSync(path.join(settings.modelDir, file), 'fixture');
  assert.equal(parakeetAvailable(settings), false);
  writeFileSync(path.join(settings.modelDir, 'tokens.txt'), 'fixture');
  assert.equal(parakeetAvailable(settings), true);
});

test('selected Parakeet is identified independently of speaking voice', t => {
  const previous = config.stt;
  t.after(() => { config.stt = previous; });
  config.stt = 'parakeet';
  assert.match(sttEngine(), /Parakeet.*v3/);
});
