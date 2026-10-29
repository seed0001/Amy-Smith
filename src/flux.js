import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// Local FLUX.2 [klein] images: one long-lived Python worker (flux_worker.py) that keeps the model
// loaded, talking JSON lines over stdin/stdout like the XTTS worker. Installed by
// scripts/setup-flux.ps1; the model itself lives outside OneDrive (config.flux.modelDir).

export function fluxAvailability(settings = config.flux) {
  const python = existsSync(settings.python);
  const model = ['model_index.json', 'transformer', 'vae', 'text_encoder'].every((f) => existsSync(path.join(settings.modelDir, f)));
  return {
    ready: python && model,
    reason: !model ? `The FLUX.2 klein model isn't at ${settings.modelDir}` : !python ? 'The Flux runtime isn\'t installed yet: your owner runs scripts\\setup-flux.ps1' : '',
  };
}

let child = null, buffer = '', stderr = '', sequence = 0;
const pending = new Map();

function fail(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
}

export function stopFlux(message = 'Flux worker stopped') {
  const c = child; child = null; fail(message); c?.kill();
}

function start(settings) {
  if (child) return;
  const worker = fileURLToPath(new URL('./flux_worker.py', import.meta.url));
  const c = spawn(settings.python, ['-u', worker, '--model-dir', settings.modelDir], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  child = c; buffer = ''; stderr = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (data) => {
    buffer += data;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { continue; } // library chatter on stdout
      const waiting = pending.get(reply.id); if (!waiting) continue;
      clearTimeout(waiting.timer); pending.delete(reply.id);
      if (reply.ok) waiting.resolve(reply); else waiting.reject(new Error(`Flux: ${reply.error || 'generation failed'}`));
    }
  });
  c.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });
  c.on('error', () => stopFlux('Could not start the Flux runtime. Check scripts\\setup-flux.ps1 was run'));
  c.stdin.on('error', () => stopFlux('Flux worker input closed'));
  c.on('exit', (code) => { if (child === c) { child = null; fail(`Flux worker exited (${code})${stderr ? `: ${stderr.slice(-500)}` : ''}`); } });
}

function request(settings, data) {
  start(settings);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    // The first call loads ~15 GB of weights, so it gets a long timeout.
    const timer = setTimeout(() => stopFlux('Flux timed out while loading or generating'), 15 * 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...data, id }) + '\n');
  });
}

// Images go through one at a time; the GPU can't hold two runs.
let queue = Promise.resolve();
export function generateFluxImage(prompt, references = [], settings = config.flux) {
  const status = fluxAvailability(settings);
  if (!status.ready) return Promise.reject(new Error(status.reason));
  const run = queue.then(async () => {
    const dir = path.join(os.tmpdir(), 'newchamp-flux');
    mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${sequence + 1}`;
    const refs = (Array.isArray(references) ? references : [references]).filter(Boolean).map((r, i) => {
      const file = path.join(dir, `${stamp}-ref${i}.png`);
      writeFileSync(file, r.bytes ?? Buffer.from(r.base64, 'base64'));
      return file;
    });
    const out = path.join(dir, `${stamp}.png`);
    try {
      await request(settings, { action: 'generate', prompt, references: refs, out });
      return { mime: 'image/png', bytes: readFileSync(out), text: '' };
    } finally {
      for (const f of [...refs, out]) rmSync(f, { force: true });
    }
  });
  queue = run.catch(() => {});
  return run;
}
