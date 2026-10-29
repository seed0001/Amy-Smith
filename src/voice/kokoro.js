import { spawn } from 'node:child_process';
// kokoro-js is loaded only when Kokoro is used: its dependencies must never stop the bot from booting.
import { config } from '../config.js';
import { activity } from '../events.js';

// Local text-to-speech with Kokoro (82M, runs on this PC's CPU, about 8x faster than real time).
// The model downloads once (Hugging Face cache). Output is converted with ffmpeg to what the caller wants:
// Ogg Opus at 48kHz for Discord voice, or mp3 for the avatar page.

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let loading = null;
// One sentence at a time: the model is single-threaded work, and order is kept anyway.
let queue = Promise.resolve();

function load() {
  loading ??= (async () => {
    const started = Date.now();
    // fp32 on the CPU: DirectML fails on one of Kokoro's layers, and q8 is slower here.
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'cpu' });
    activity('ready', { message: `Kokoro TTS loaded in ${((Date.now() - started) / 1000).toFixed(1)}s` });
    return tts;
  })().catch((err) => {
    loading = null;
    throw new Error(`Could not load Kokoro: ${err.message}`);
  });
  return loading;
}

export const loadKokoro = load;

export async function kokoroVoices() {
  return Object.keys((await load()).voices);
}

export function kokoroSynthesize(text, { format = 'opus' } = {}) {
  const job = queue.then(async () => {
    const tts = await load();
    const audio = await tts.generate(text, { voice: config.kokoro.voice, speed: config.kokoro.speed });
    return encode(audio.audio, audio.sampling_rate, format);
  });
  queue = job.catch(() => {});
  return job;
}

// Float32 mono PCM -> Ogg Opus 48kHz (Discord) or mp3.
function encode(samples, rate, format) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const out = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3'] : ['-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '2', '-f', 'ogg'];
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', ...out, 'pipe:1']);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${err.slice(0, 200)}`))));
    ff.stdin.end(pcm);
  });
}
