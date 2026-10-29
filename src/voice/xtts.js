import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const AUDIO = /\.(wav|mp3|flac|ogg|m4a)$/i;
export function xttsSamples(settings = config.xtts) {
  if (!settings || !existsSync(settings.referenceDir)) return [];
  return readdirSync(settings.referenceDir, { withFileTypes: true }).filter((f) => f.isFile() && AUDIO.test(f.name)).map((f) => f.name).sort();
}

export function xttsReference(settings = config.xtts) {
  const samples = xttsSamples(settings);
  const selected = settings?.reference || (samples.includes('reference.wav') ? 'reference.wav' : samples[0]);
  if (!selected || path.basename(selected) !== selected || !samples.includes(selected)) return null;
  const file = path.join(settings.referenceDir, selected);
  return statSync(file).size > 44 ? file : null;
}

export function xttsAvailability(settings = config.xtts) {
  if (!settings) return { ready: false, reason: 'XTTS is not configured' };
  const installed = existsSync(settings.python) && ['config.json', 'model.pth', 'vocab.json', 'speakers_xtts.pth'].every((f) => existsSync(path.join(settings.modelDir, f)));
  const reference = xttsReference(settings);
  return { ready: Boolean(installed && reference), installed, reference: reference ? path.basename(reference) : null, referenceDir: settings.referenceDir, language: settings.language, speed: settings.speed, device: 'cpu', reason: !installed ? 'Install the local XTTS runtime and model first' : !reference ? `Add your voice sample to ${settings.referenceDir}${settings.reference ? ` (selected: ${settings.reference})` : ''}` : '' };
}

export class XTTSWorker {
  constructor(settings, { spawnImpl = spawn } = {}) { this.settings = settings; this.spawnImpl = spawnImpl; this.child = null; this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.stderr = ''; }
  start() {
    if (this.child) return;
    const workerPath = fileURLToPath(new URL('./xtts_worker.py', import.meta.url));
    const child = this.spawnImpl(this.settings.python, ['-u', workerPath, '--model-dir', this.settings.modelDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    this.child = child; this.buffer = ''; this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      this.buffer += data;
      if (this.buffer.length > 32 * 1024 * 1024) { this.stop('XTTS response exceeded the audio size limit'); return; }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { this.stop('XTTS worker returned invalid data'); return; }
        const waiting = this.pending.get(reply.id); if (!waiting) continue;
        clearTimeout(waiting.timer); this.pending.delete(reply.id);
        if (reply.ok) waiting.resolve(reply); else waiting.reject(new Error(`XTTS: ${reply.error || 'synthesis failed'}`));
      }
    });
    child.stderr.on('data', (data) => { this.stderr = (this.stderr + data.toString()).slice(-2000); });
    child.on('error', () => this.stop('Could not start XTTS. Check the configured Python runtime'));
    child.stdin.on('error', () => this.stop('XTTS worker input closed'));
    child.on('exit', (code) => { if (this.child === child) { this.child = null; this.fail(`XTTS worker exited (${code})${this.stderr ? `: ${this.stderr.slice(-500)}` : ''}`); } });
  }
  fail(message) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } this.pending.clear(); }
  stop(message = 'XTTS worker stopped') { const child = this.child; this.child = null; this.fail(message); child?.kill(); }
  request(action, data = {}) {
    this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop('XTTS timed out while loading or generating speech'), 300000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...data, id, action }) + '\n');
    });
  }
}

let worker, workerKey = '', queue = Promise.resolve();
function instance(settings = config.xtts) {
  const key = `${settings.python}|${settings.modelDir}`;
  if (!worker || workerKey !== key) { worker?.stop(); worker = new XTTSWorker(settings); workerKey = key; }
  return worker;
}
export async function loadXTTS(settings = config.xtts) {
  const status = xttsAvailability(settings);
  if (!status.ready) throw new Error(status.reason);
  return instance(settings).request('warmup', { reference: xttsReference(settings) });
}
export function stopXTTS() { worker?.stop(); worker = null; workerKey = ''; }

export function encodeXTTS(wav, format = 'opus') {
  if (!['opus', 'mp3'].includes(format)) throw new Error('XTTS supports opus or mp3 output');
  return new Promise((resolve, reject) => {
    const output = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3'] : ['-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '2', '-f', 'ogg'];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...output, 'pipe:1'], { windowsHide: true });
    const chunks = []; let error = '';
    const timeout = setTimeout(() => { ff.kill(); reject(new Error('XTTS audio conversion timed out')); }, 30000);
    ff.stdout.on('data', (chunk) => chunks.push(chunk)); ff.stderr.on('data', (chunk) => { error = (error + chunk.toString()).slice(-1000); });
    ff.stdin.on('error', () => {});
    ff.on('error', () => { clearTimeout(timeout); reject(new Error('FFmpeg is required for XTTS audio output')); });
    ff.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`XTTS audio conversion failed: ${error}`)); });
    ff.stdin.end(wav);
  });
}
export function xttsSynthesize(text, { format = 'opus' } = {}) {
  // Capture these at enqueue time so changing providers/voices cannot change an old sentence.
  const settings = { ...config.xtts }, reference = xttsReference(settings);
  const job = queue.then(async () => {
    const status = xttsAvailability(settings);
    if (!status.ready) throw new Error(status.reason);
    const result = await instance(settings).request('synthesize', { text, reference, language: settings.language, speed: settings.speed });
    if (typeof result.audio !== 'string') throw new Error('XTTS returned no audio');
    return encodeXTTS(Buffer.from(result.audio, 'base64'), format);
  });
  queue = job.catch(() => {});
  return job;
}
export function ensureXTTSSampleFolder() { mkdirSync(config.xtts.referenceDir, { recursive: true }); }
