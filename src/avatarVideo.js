import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { synthesize } from './voice/fishAudio.js';
import { activity } from './events.js';
import { ttsReady } from './voice/provider.js';

// Video replies (Amy's spec, Downloads/amy-avatar-video-spec): a reply in a Discord text channel
// can also arrive as a clip of her avatar's face saying it. The avatar page, opened in recorder
// mode (/avatar.html?recorder=1) and left open, records it live: it keeps an event stream to us,
// we send it the reply's lines with their voice, it plays and records them, and uploads a .webm.
// Nothing here ever holds up the text reply; if anything fails, there's simply no clip.
// Nobody has to open that page: when a clip is wanted and none is open, we open it ourselves in
// a hidden (headless) Chrome or Edge that may play audio without a click, and keep it running.

export const MAX_CLIP_BYTES = 20 * 1024 * 1024; // over this, text only (spec guard)
const MAX_TEXT = 900; // ~45 s of speech; longer replies stay text-only
const ACK_MS = 8_000; // the page must start recording within this
const CLIP_MS = 120_000; // and finish within this
const LAUNCH_MS = 60_000; // a hidden recorder must connect (and load her model) within this

const recorders = new Set(); // open event streams from recorder pages
const jobs = new Map(); // id -> { resolve, timer }
let nextId = 1;
let hidden = null; // the hidden recorder browser we started, while it runs

export const recorderConnected = () => recorders.size > 0;

// Chrome or Edge on this computer (AVATAR_BROWSER overrides), or null.
export function findBrowser(env = process.env, exists = existsSync) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    env.AVATAR_BROWSER,
    ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => p && exists(p)) ?? null;
}

// The hidden recorder page's address and browser switches. `silent` keeps her voice off the
// speakers (the clip records it before the volume control).
export function recorderLaunch({ host, port, password, profile }) {
  const auth = password ? `recorder:${encodeURIComponent(password)}@` : '';
  const at = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${auth}${at}:${port}/avatar.html?recorder=1&silent=1`;
  return [
    '--headless=new', `--user-data-dir=${profile}`, '--window-size=1280,720', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    url,
  ];
}

function launchRecorder() {
  if (hidden) return true;
  const bin = findBrowser();
  if (!bin) {
    activity('video', { message: 'No clip: no Chrome or Edge found to run the hidden recorder (set AVATAR_BROWSER)' });
    return false;
  }
  const args = recorderLaunch({ host: config.dashboard.host, port: config.dashboard.port, password: config.dashboard.password, profile: path.join(os.tmpdir(), 'amy-avatar-recorder') });
  try {
    hidden = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    activity('error', { where: 'avatar video', message: `Couldn't start the hidden recorder: ${err.message}` });
    return false;
  }
  activity('video', { message: 'Started the hidden avatar video recorder' });
  const child = hidden;
  const gone = () => hidden === child && (hidden = null);
  child.on('error', (err) => { gone(); activity('error', { where: 'avatar video', message: `Hidden recorder: ${err.message}` }); });
  child.on('exit', gone);
  return true;
}

// Waits for a recorder page to connect; true if one did.
function recorderReady(ms) {
  if (recorders.size) return Promise.resolve(true);
  return new Promise((ok) => {
    const started = Date.now();
    const check = () => (recorders.size ? ok(true) : !hidden || Date.now() - started > ms ? ok(false) : setTimeout(check, 250));
    check();
  });
}

// A recorder page is open, or we start the hidden one and wait for it. True when one is ready.
export async function ensureRecorder() {
  if (recorders.size) return true;
  return launchRecorder() && recorderReady(LAUNCH_MS);
}

process.on('exit', () => hidden?.kill());

// The recorder page's event stream. While it's open, the page is alive (that's the heartbeat).
export function attachRecorder(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  recorders.add(res);
  activity('video', { message: 'Avatar video recorder connected' });
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    recorders.delete(res);
    activity('video', { message: 'Avatar video recorder disconnected' });
    // Its unfinished clips won't come now; give up on them straight away instead of timing out.
    for (const [id, job] of jobs) if (job.page === res) finish(id, null, 'the recorder page closed');
  });
}

const sentences = (text) => text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*["')\]]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

// Asks the recorder for a clip of `text`. Resolves to a Buffer, or null when there's no clip
// (switched off, no recorder could be opened, too long, or any failure); never throws.
export async function requestClip(text) {
  if (!config.avatarVideo || !ttsReady(config)) return null;
  const clean = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').trim(); // speak prose, not markdown
  if (!clean) return null;
  if (clean.length > MAX_TEXT) {
    activity('video', { message: `No clip: reply is ${clean.length} characters (limit ${MAX_TEXT})` });
    return null;
  }
  try {
    const lines = sentences(clean);
    const [audio, ready] = await Promise.all([Promise.all(lines.map((s) => synthesize(s, { format: 'mp3' }))), ensureRecorder()]);
    if (!ready) {
      activity('video', { message: 'No clip: the recorder page did not open' });
      return null;
    }
    const id = nextId++;
    const [page] = recorders;
    const done = new Promise((resolve) => {
      const giveUp = (why) => () => finish(id, null, why);
      jobs.set(id, { resolve, page, timer: setTimeout(giveUp('the recorder did not start in time'), ACK_MS) });
    });
    page.write(`data: ${JSON.stringify({ type: 'job', id, lines: lines.map((t, i) => ({ text: t, audio: audio[i].toString('base64') })) })}\n\n`);
    return await done;
  } catch (err) {
    activity('error', { where: 'avatar video', message: err.message });
    return null;
  }
}

// The page started recording: switch to the longer deadline.
export function ack(id) {
  const job = jobs.get(Number(id));
  if (!job) return false;
  clearTimeout(job.timer);
  job.timer = setTimeout(() => finish(Number(id), null, 'the recording took too long'), CLIP_MS);
  return true;
}

export function finish(id, clip, why) {
  const job = jobs.get(Number(id));
  if (!job) return false;
  jobs.delete(Number(id));
  clearTimeout(job.timer);
  if (clip && clip.length > MAX_CLIP_BYTES) {
    why = `clip is ${(clip.length / 1048576).toFixed(1)} MB, over the 20 MB limit`;
    clip = null;
  }
  if (!clip) activity('video', { message: `No clip for reply #${id}: ${why || 'failed'}` });
  job.resolve(clip);
  return true;
}
