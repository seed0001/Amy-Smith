import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

export function parakeetAvailable(settings = config.parakeet) {
  return [settings.python, ...['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].map(f => path.join(settings.modelDir, f))].every(existsSync);
}

export class ParakeetWorker {
  constructor(settings, { spawnImpl = spawn } = {}) {
    this.settings = settings; this.spawnImpl = spawnImpl;
    this.child = null; this.sequence = 0; this.pending = new Map(); this.queue = Promise.resolve();
  }
  stop(message = 'Parakeet worker stopped') {
    const child = this.child; this.child = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear(); child?.kill();
  }
  start() {
    if (this.child) return;
    const child = this.spawnImpl(this.settings.python, ['-u', fileURLToPath(new URL('./parakeet_worker.py', import.meta.url)), '--model-dir', this.settings.modelDir, '--threads', String(this.settings.threads)], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' },
    });
    this.child = child;
    let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return this.stop('Parakeet response exceeded size limit');
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        let response;
        try { response = JSON.parse(line); } catch { this.stop('Parakeet returned invalid data'); return; }
        const pending = this.pending.get(response.id); if (!pending) continue;
        this.pending.delete(response.id); clearTimeout(pending.timer);
        if (response.ok && typeof response.text === 'string') pending.resolve(response);
        else pending.reject(new Error(`Parakeet: ${response.error || 'invalid transcript'}`));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', () => { if (this.child === child) this.stop('Could not start local Parakeet. Run scripts/setup-parakeet.ps1'); });
    child.stdin.on('error', () => { if (this.child === child) this.stop('Parakeet input closed'); });
    child.on('exit', code => { if (this.child === child) this.stop(`Parakeet exited (${code}): ${stderr.slice(-500)}`); });
  }
  transcribe(pcm) {
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 48000 * 2 * 120) return Promise.reject(new Error('Parakeet requires up to 120 seconds of 48kHz mono PCM16'));
    // Trim the final partial downsampling group; keep caller's buffer intact.
    const audio = Buffer.from(pcm.subarray(0, pcm.length - pcm.length % 6));
    if (!audio.length) return Promise.resolve({ text: '', ms: 0 });
    const job = this.queue.then(() => {
      this.start();
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.stop('Local Parakeet transcription timed out'), 120000);
        this.pending.set(id, { resolve, reject, timer });
        this.child.stdin.write(JSON.stringify({ id, pcm: audio.toString('base64') }) + '\n');
      });
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

let worker;
export async function transcribeParakeet(pcm) {
  if (!parakeetAvailable()) throw new Error('Local Parakeet is not installed. Run scripts/setup-parakeet.ps1');
  worker ??= new ParakeetWorker(config.parakeet);
  return (await worker.transcribe(pcm)).text.trim();
}
process.once('exit', () => worker?.stop());
