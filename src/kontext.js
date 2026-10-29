import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

// Local FLUX.1 Kontext images through stable-diffusion.cpp's Vulkan build (sd-cli.exe). Vulkan runs on
// the AMD card's normal driver, so this needs no ROCm or PyTorch. Kontext follows instructions
// against a reference picture ("same person, now in a red jacket"), which is how her selfies keep
// her face. Each image is one sd-cli.exe run; the files live outside OneDrive (config.kontext).

const FILES = (s) => [s.exe, s.model, s.vae, s.clipL, s.t5xxl];

export function kontextAvailability(settings = config.kontext) {
  const missing = FILES(settings).filter((f) => !existsSync(f));
  return { ready: !missing.length, reason: missing.length ? `Local Kontext files are missing: ${missing.join(', ')}` : '' };
}

const run = (exe, args, timeout) =>
  new Promise((ok, fail) => {
    execFile(exe, args, { cwd: path.dirname(exe), timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const out = `${stderr}\n${stdout}`.split('\n').filter((l) => /error|fail|cannot|not found|invalid/i.test(l)).slice(-4).join(' | ');
        fail(new Error(`Kontext: ${out || err.message}`.slice(0, 600)));
      } else ok(stdout);
    });
  });

// One image at a time; the GPU can't hold two runs.
let queue = Promise.resolve();
export function generateKontextImage(prompt, references = [], settings = config.kontext) {
  const status = kontextAvailability(settings);
  if (!status.ready) return Promise.reject(new Error(status.reason));
  const job = queue.then(async () => {
    const dir = path.join(os.tmpdir(), 'newchamp-kontext');
    mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const refs = (Array.isArray(references) ? references : [references]).filter(Boolean).map((r, i) => {
      const file = path.join(dir, `${stamp}-ref${i}.png`);
      writeFileSync(file, r.bytes ?? Buffer.from(r.base64, 'base64'));
      return file;
    });
    const out = path.join(dir, `${stamp}.png`);
    const args = [
      '--diffusion-model', settings.model, '--vae', settings.vae, '--clip_l', settings.clipL, '--t5xxl', settings.t5xxl,
      '-p', String(prompt), '--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', String(settings.steps),
      '-W', '1024', '-H', '1024', '-o', out,
      ...refs.flatMap((f) => ['-r', f]),
    ];
    try {
      await run(settings.exe, args, 15 * 60_000);
      if (!existsSync(out)) throw new Error('Kontext finished without writing an image');
      return { mime: 'image/png', bytes: readFileSync(out), text: '' };
    } finally {
      for (const f of [...refs, out]) rmSync(f, { force: true });
    }
  });
  queue = job.catch(() => {});
  return job;
}
